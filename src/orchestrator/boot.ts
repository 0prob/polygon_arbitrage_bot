import { type PublicClient } from "viem";
import type { AppConfig } from "../config/schema.ts";
import { createRootLogger, type Logger } from "../infra/observability/logger.ts";
import type { RouteStateCache } from "../core/types/route.ts";
import { ExecutionService } from "../services/execution/service.ts";
import { SubmissionStrategy, type SubmitTxFn } from "../services/execution/submit.ts";
import { ReceiptPoller } from "../services/execution/receipt.ts";
import { GasOracle, createGasFetcher, type GasOracleConfig } from "../services/execution/gas.ts";
import { NonceManager } from "../services/execution/nonce.ts";
import { MempoolService, type MempoolServiceOptions } from "../services/mempool/service.ts";
import { InMemoryPendingStateOverlay } from "../core/types/overlay.ts";
import { CircuitBreaker } from "../infra/resilience/circuit_breaker.ts";
import { TierManager } from "../infra/resilience/tier_manager.ts";
import type { HyperIndexMonitor } from "../infra/resilience/hyperindex_monitor.ts";
import { MempoolAwareDryRunner } from "../services/execution/dryrun.ts";
import { IncrementalGraphUpdater } from "../pipeline/graph_incremental.ts";
import { type Metrics } from "../core/types/metrics.ts";
import { RpcManager } from "../rpc/manager.ts";
import type { ReorgDetector } from "../infra/resilience/reorg_detector.ts";
import type { WebSocketSubscriber } from "../infra/rpc/websocket_subscriber.ts";
import type { HyperRpcClient } from "../infra/rpc/hyperrpc.ts";
import type { HyperSyncService } from "../infra/hypersync/hypersync_service.ts";

export interface RuntimeContext {
  config: AppConfig;
  logger: Logger;
  stateCache: RouteStateCache;
  executionService: ExecutionService;
  mempoolService: MempoolService;
  publicClient: PublicClient;
  /** Dedicated client for state-fetching multicalls; shares publicClient if no separate URL configured */
  stateClient: PublicClient;
  rpc: RpcManager;
  isRunning: boolean;
  gasOracle: GasOracle;
  metrics: Metrics;
  rpcCircuit: CircuitBreaker;
  hasuraCircuit: CircuitBreaker;
  tierManager: TierManager;
  hyperIndexMonitor?: HyperIndexMonitor;
  reorgDetector?: ReorgDetector;
  wsSubscriber?: WebSocketSubscriber;
  dryRunner?: MempoolAwareDryRunner;
  graphUpdater?: IncrementalGraphUpdater;
  pendingStateOverlay?: InMemoryPendingStateOverlay;

  /**
   * Optional HyperRPC client (read-only, high performance).
   * Only present when HYPERRPC_API_TOKEN is configured.
   * Use exclusively for the read methods it supports.
   */
  hyperRpc?: HyperRpcClient;

  /** Official high-performance HyperSync client wrapper (recommended for most reads) */
  hyperSync?: HyperSyncService;
}

export async function bootApplication(
  config: AppConfig,
  logBuffer?: string[],
  passedLogger?: Logger,
  hyperIndexMonitor?: HyperIndexMonitor,
): Promise<RuntimeContext> {
  const logger =
    passedLogger ??
    createRootLogger({
      level: config.observability.logLevel,
      logSink: logBuffer,
    });
  logger.info("bootApplication started");

  const metrics: Metrics = {
    cycles: 0,
    lastCycleDurationMs: 0,
    totalErrors: 0,
    lastErrorTime: null,
    lastErrorMessage: null,
    opportunitiesFound: 0,
    executionsAttempted: 0,
    executionsSuccessful: 0,
    executionsFailed: 0,
    executionReverts: 0,
    trackedRoutes: 0,
    startTime: Date.now(),
    peakCyclesPerMinute: 0,
    currentCyclesPerMinute: 0,
  };

  const rpc = new RpcManager(config.rpc);
  const publicClient = rpc.getReadClient();

  let stateClient: PublicClient;
  if (config.rpc.stateRpcUrl) {
    stateClient = rpc.addStateClient(config.rpc.stateRpcUrl, config.rpc.batchSize, config.rpc.batchWaitMs);
  } else {
    stateClient = publicClient;
  }

  const stateCache: RouteStateCache = new Map();

  // Basic validation: ensure executorAddress is a contract
  const executorCode = await publicClient.getBytecode({ address: config.execution.executorAddress as `0x${string}` });
  if (!executorCode || executorCode === "0x") {
    logger.error(
      { executorAddress: config.execution.executorAddress },
      "Executor address is not a deployed contract! Bot will fail to execute.",
    );
  } else {
    logger.info(
      { executorAddress: config.execution.executorAddress, flashLoanSource: config.execution.flashLoanSource },
      "Executor contract validated",
    );
  }

  const gasOracleConfig: GasOracleConfig = {
    pollIntervalMs: config.gas.pollIntervalMs,
    priorityFeeFloorGwei: config.gas.priorityFeeFloorGwei,
    priorityFeeCeilingGwei: config.gas.priorityFeeCeilingGwei,
    maxBidMultiplier: config.gas.maxBidMultiplier,
    eip1559Enabled: config.gas.eip1559Enabled,
    feeHistoryPercentile: config.gas.feeHistoryPercentile,
    emaAlpha: config.gas.emaAlpha,
    baseFeeBufferMultiplier: config.gas.baseFeeBufferMultiplier,
    maxPriorityFeePercentile: config.gas.maxPriorityFeePercentile,
    historySize: config.gas.historySize,
    spikePriorityFeeMultiplier: config.gas.spikePriorityFeeMultiplier ?? 1.6,
  };

  const fetchGas = createGasFetcher(publicClient, {
    feeHistoryPercentile: config.gas.feeHistoryPercentile,
    feeHistoryBlockCount: 2,
  });

  const gasOracle = new GasOracle(gasOracleConfig, fetchGas, logger);

  const nonceFetcher = async (address: string): Promise<number> => {
    const count = await publicClient.getTransactionCount({ address: address as `0x${string}`, blockTag: "pending" });
    return Number(count);
  };

  const walletClients =
    config.execution.privateRelayUrls.length > 0
      ? config.execution.privateRelayUrls.map((url) => rpc.addExecutionClient(url, config.execution.privateKey))
      : [rpc.addExecutionClient(config.rpc.executionRpcUrl, config.execution.privateKey)];

  walletClients.forEach((wc) => {
    if (!wc.account) {
      throw new Error("Execution client is not configured with an account.");
    }
  });

  const stuckTxHandler = async (nonce: number, maxFee: bigint): Promise<void> => {
    if (walletClients.length === 0) return;
    // Broadcast cancellation to all relays to ensure the stuck nonce is cleared everywhere.
    await Promise.allSettled(
      walletClients.map((wc) =>
        wc
          .sendTransaction({
            account: wc.account!,
            chain: wc.chain,
            to: wc.account!.address,
            value: 0n,
            data: "0x",
            nonce,
            maxFeePerGas: maxFee,
            maxPriorityFeePerGas: maxFee / 2n,
          })
          .catch(() => {}),
      ),
    );
  };

  const nonceManager = new NonceManager(config.execution.executorAddress, nonceFetcher, stuckTxHandler);

  const submitters = walletClients.map((walletClient) => {
    return async (tx: { to: string; data: string; value: bigint; nonce: number; maxFee: bigint }): Promise<string> => {
      const hash = await walletClient.sendTransaction({
        account: walletClient.account!,
        chain: walletClient.chain,
        to: tx.to as `0x${string}`,
        data: tx.data as `0x${string}`,
        value: tx.value,
        nonce: tx.nonce,
        maxFeePerGas: tx.maxFee,
        maxPriorityFeePerGas: tx.maxFee / 2n,
      });
      return hash;
    };
  });

  let privateSubmitter: SubmitTxFn | undefined;
  if (config.execution.submissionStrategy !== "public" && config.execution.privateRelayUrls.length > 0) {
    const privateClients = config.execution.privateRelayUrls.map((url) => rpc.addPrivateRelayClient(url, config.execution.privateKey));
    privateClients.forEach((wc) => {
      if (!wc.account) throw new Error("Private relay client is not configured with an account.");
    });
    privateSubmitter = async (tx) => {
      const hash = await privateClients[0].sendTransaction({
        account: privateClients[0].account!,
        chain: privateClients[0].chain,
        to: tx.to as `0x${string}`,
        data: tx.data as `0x${string}`,
        value: tx.value,
        nonce: tx.nonce,
        maxFeePerGas: tx.maxFee,
        maxPriorityFeePerGas: tx.maxFee / 2n,
      });
      return hash;
    };
  }

  const submissionStrategy = new SubmissionStrategy(logger, gasOracle, submitters, {
    submissionStrategy: config.execution.submissionStrategy,
    privateSubmitter,
  });

  const receiptPoller = new ReceiptPoller(logger, rpc, config.execution.receiptTimeoutMs, config.execution.receiptPollMs);

  const executionService = new ExecutionService(
    logger,
    submissionStrategy,
    receiptPoller,
    gasOracle,
    nonceManager,
    config.execution.quarantineBaseMs,
    config.execution.quarantineMaxMs,
  );

  const approxRawPerUsd = 10n ** 15n; // rough to map USD threshold to raw amount units (varies by token decimals/price)
  const mempoolOptions: MempoolServiceOptions = {
    coalesceTtlMs: config.mempool.coalesceTtlMs,
    largeSwapThresholdWei: BigInt(Math.floor(config.mempool.largeSwapThresholdUsd)) * approxRawPerUsd,
  };
  const pendingStateOverlay = new InMemoryPendingStateOverlay();
  const mempoolService = new MempoolService(logger, mempoolOptions, pendingStateOverlay);
  const mempoolWsUrl = config.mempool.enabled ? config.mempool.websocketUrl : "";

  const rpcCircuit = new CircuitBreaker("polygon-rpc", {
    failureThreshold: 3,
    cooldownMs: 30_000,
  });
  const hasuraCircuit = new CircuitBreaker("hasura", {
    failureThreshold: 5,
    cooldownMs: 60_000,
  });
  const tierManager = new TierManager(rpcCircuit, hasuraCircuit, hyperIndexMonitor);

  // Reorg detector
  const reorgDetector = rpc.getReorgDetector();

  // WebSocket subscriber (provides newHeads for timing + pendingTx to mempool). Gated by mempool.enabled + url.
  const wsSubscriber = mempoolWsUrl ? rpc.addWebSocketSubscriber(mempoolWsUrl) : undefined;

  // Mempool-aware dry runner
  const dryRunner = new MempoolAwareDryRunner(publicClient);

  // Incremental graph updater
  const graphUpdater = new IncrementalGraphUpdater(config.routing.graphFullRebuildInterval);

  // Boot warmup: pre-warm gas oracle and state cache
  logger.info("Starting boot warmup...");
  try {
    // Warm gas oracle with 3 quick polls
    await gasOracle.start();
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
  } catch (err) {
    logger.warn({ err }, "Gas oracle warmup failed, continuing with cold start");
  }

  logger.info("Ready — entering pass loop");

  return {
    config,
    logger,
    stateCache,
    executionService,
    mempoolService,
    publicClient,
    stateClient,
    rpc,
    isRunning: true,
    gasOracle,
    metrics,
    rpcCircuit,
    hasuraCircuit,
    tierManager,
    reorgDetector,
    wsSubscriber,
    dryRunner,
    graphUpdater,
    pendingStateOverlay,
    hyperRpc: rpc.hyperRpc,
    hyperSync: rpc.hyperSync,
    hyperIndexMonitor,
  };
}
