import { type PublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { AppConfig } from "../config/schema.ts";
import { createRootLogger, type Logger } from "../infra/observability/logger.ts";
import type { RouteStateCache } from "../core/types/route.ts";
import type { PoolMeta } from "../core/types/pool.ts";
import { ExecutionService, type SubmitTxFn } from "../services/execution/service.ts";
import { GasOracle, type GasOracleConfig } from "../services/execution/gas.ts";
import { NonceManager } from "../services/execution/nonce.ts";
import { MempoolService, type MempoolServiceOptions } from "../services/mempool/service.ts";
import { CrossChainScanner } from "../services/crosschain/scanner.ts";
import { SolverBot } from "../services/crosschain/solver.ts";
import { createReadClient, createExecutionClient } from "../infra/rpc/client_factory.ts";
import { ServiceRegistry } from "../infra/di/service_registry.ts";
import { CircuitBreaker } from "../infra/resilience/circuit_breaker.ts";
import { TierManager } from "../infra/resilience/tier_manager.ts";
import type { HyperIndexMonitor } from "../infra/resilience/hyperindex_monitor.ts";
import { FastLaneSubmitter } from "../infra/rpc/fastlane.ts";
import { ReorgDetector } from "../infra/resilience/reorg_detector.ts";
import { WebSocketSubscriber } from "../infra/rpc/websocket_subscriber.ts";
import { MempoolAwareDryRunner } from "../services/execution/dryrun.ts";
import { IncrementalGraphUpdater } from "../services/strategy/graph_incremental.ts";
import { getChain } from "../infra/rpc/chains.ts";
import { type Metrics } from "../core/types/metrics.ts";

export interface RuntimeContext {
  config: AppConfig;
  logger: Logger;
  stateCache: RouteStateCache;
  executionService: ExecutionService;
  mempoolService: MempoolService;
  getPools: () => PoolMeta[];
  publicClient: PublicClient;
  isRunning: boolean;
  gasOracle: GasOracle;
  crossChainScanner?: CrossChainScanner;
  solverBot?: SolverBot;
  metrics: Metrics;
  services: ServiceRegistry;
  rpcCircuit: CircuitBreaker;
  hasuraCircuit: CircuitBreaker;
  tierManager: TierManager;
  hyperIndexMonitor?: HyperIndexMonitor;
  reorgDetector?: ReorgDetector;
  wsSubscriber?: WebSocketSubscriber;
  dryRunner?: MempoolAwareDryRunner;
  graphUpdater?: IncrementalGraphUpdater;
}

export async function bootApplication(config: AppConfig, logBuffer?: string[], passedLogger?: Logger): Promise<RuntimeContext> {
  const logger =
    passedLogger ??
    createRootLogger({
      level: config.observability.logLevel,
      logSink: logBuffer,
    });

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

  const publicClient = createReadClient(config.rpc.polygonRpcUrls, {
    chainId: 137,
    timeoutMs: config.rpc.requestTimeoutMs,
    batchSize: config.rpc.batchSize,
    batchWaitMs: config.rpc.batchWaitMs,
  });

  const stateCache: RouteStateCache = new Map();

  const getPools = (): PoolMeta[] => {
    return [];
  };

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
  };

  const fetchGas = async () => {
    try {
      const [block, priorityFee] = await Promise.all([
        publicClient.getBlock({ blockTag: "latest" }),
        publicClient.estimateMaxPriorityFeePerGas().catch(() => 30n * 10n ** 9n),
      ]);
      const baseFee = block.baseFeePerGas ?? 30n * 10n ** 9n;
      return { baseFee, priorityFee };
    } catch {
      return { baseFee: 30n * 10n ** 9n, priorityFee: 30n * 10n ** 9n };
    }
  };

  const gasOracle = new GasOracle(gasOracleConfig, fetchGas);

  const nonceFetcher = async (address: string): Promise<number> => {
    const count = await publicClient.getTransactionCount({ address: address as `0x${string}`, blockTag: "pending" });
    return Number(count);
  };

  const stuckTxHandler = async (nonce: number, maxFee: bigint): Promise<void> => {
    if (walletClients.length === 0) return;
    const wc = walletClients[0];
    await wc
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
      .catch(() => {});
  };

  const nonceManager = new NonceManager(config.execution.executorAddress, nonceFetcher, stuckTxHandler);

  const walletClients =
    config.execution.privateRelayUrls.length > 0
      ? config.execution.privateRelayUrls.map((url) => createExecutionClient(url, config.execution.privateKey, 137))
      : [createExecutionClient(config.rpc.executionRpcUrl, config.execution.privateKey, 137)];

  walletClients.forEach((wc) => {
    if (!wc.account) {
      throw new Error("Execution client is not configured with an account.");
    }
  });

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
    const privateClients = config.execution.privateRelayUrls.map((url) => createExecutionClient(url, config.execution.privateKey, 137));
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

  // FastLane submitter
  let fastLaneSubmitter: FastLaneSubmitter | undefined;
  if (config.fastlane.enabled) {
    const fastLaneClient = createWalletClient({
      account: privateKeyToAccount(config.execution.privateKey as `0x${string}`),
      chain: getChain(137),
      transport: http(config.fastlane.rpcUrl),
    });
    fastLaneSubmitter = new FastLaneSubmitter(
      {
        enabled: config.fastlane.enabled,
        rpcUrl: config.fastlane.rpcUrl,
        conditional: {
          blockNumberWindow: config.fastlane.blockNumberWindow,
          timestampWindowS: config.fastlane.timestampWindowS,
        },
      },
      fastLaneClient,
    );
    logger.info({ rpcUrl: config.fastlane.rpcUrl }, "FastLane submitter initialized");
  }

  const executionService = new ExecutionService(logger, gasOracle, nonceManager, submitters, {
    submissionStrategy: config.execution.submissionStrategy,
    privateSubmitter,
    fastLaneSubmitter,
    chainId: config.execution.chainId,
    receiptTimeoutMs: config.execution.receiptTimeoutMs,
    receiptPollMs: config.execution.receiptPollMs,
    quarantineBaseMs: config.execution.quarantineBaseMs,
    quarantineMaxMs: config.execution.quarantineMaxMs,
  });

  const mempoolOptions: MempoolServiceOptions = {
    coalesceTtlMs: config.mempool.coalesceTtlMs,
    largeSwapThresholdWei: 10n ** 18n,
  };
  const mempoolService = new MempoolService(logger, mempoolOptions);

  // Wire mempool pending tx watcher if WebSocket URL is configured
  let mempoolWsClient: PublicClient | undefined;
  if (config.mempool.websocketUrl) {
    try {
      const { createPublicClient, webSocket } = await import("viem");
      mempoolWsClient = createPublicClient({
        transport: webSocket(config.mempool.websocketUrl),
      });
      mempoolWsClient.watchPendingTransactions({
        onTransactions: async (hashes) => {
          for (const hash of hashes.slice(0, 10)) {
            try {
              const tx = await mempoolWsClient!.getTransaction({ hash });
              if (tx && tx.to) {
                mempoolService.processPendingTx({
                  hash: tx.hash,
                  to: tx.to,
                  input: tx.input,
                  value: tx.value?.toString() ?? "0",
                });
              }
            } catch {
              /* tx may have been mined before we fetch it */
            }
          }
        },
      });
      logger.info({ url: config.mempool.websocketUrl }, "Mempool pending tx watcher started");
    } catch (err) {
      logger.warn({ err }, "Failed to start mempool WebSocket watcher");
    }
  }

  let crossChainScanner: CrossChainScanner | undefined;
  let solverBot: SolverBot | undefined;

  if (config.crossChainArb?.enabled) {
    crossChainScanner = new CrossChainScanner({
      katanaRpcUrl: config.crossChainArb.katanaRpcUrl,
      escrowToken: config.crossChainArb.escrowToken as `0x${string}`,
      escrowAmount: config.crossChainArb.escrowAmount,
      minProfitBps: config.crossChainArb.minProfitBps,
      maxSwapHops: config.crossChainArb.maxSwapHops,
    });
    solverBot = new SolverBot({
      polygonSolverKey: config.crossChainArb.polygonSolverPrivateKey as `0x${string}`,
      katanaSolverKey: config.crossChainArb.katanaSolverPrivateKey as `0x${string}`,
      crossChainIntentOrigin: config.crossChainArb.originSettlerAddress as `0x${string}`,
      katanaExecutor: config.crossChainArb.katanaExecutorAddress as `0x${string}`,
      escrowToken: config.crossChainArb.escrowToken as `0x${string}`,
      escrowAmount: config.crossChainArb.escrowAmount,
      polygonRpcUrl: config.rpc.polygonRpcUrls[0],
      katanaRpcUrl: config.crossChainArb.katanaRpcUrl,
    });
  }

  const services = new ServiceRegistry();
  services.register("logger", logger);
  services.register("execution", executionService, {
    prepare: async () => {},
    start: async () => {
      await executionService.start();
    },
    stop: async () => {
      executionService.stop();
    },
  });
  services.register("mempool", mempoolService, {
    prepare: async () => {},
    start: async () => {
      await mempoolService.start();
    },
    stop: async () => {
      mempoolService.stop();
    },
  });
  services.register("gasOracle", gasOracle, {
    prepare: async () => {},
    start: async () => {
      await gasOracle.start();
    },
    stop: async () => {
      gasOracle.stop();
    },
  });

  const rpcCircuit = new CircuitBreaker("polygon-rpc", {
    failureThreshold: 3,
    cooldownMs: 30_000,
  });
  const hasuraCircuit = new CircuitBreaker("hasura", {
    failureThreshold: 5,
    cooldownMs: 60_000,
  });
  const tierManager = new TierManager(rpcCircuit, hasuraCircuit, {
    isHealthy: () => true,
    isRunning: () => true,
  } as any);

  services.register("rpcCircuit", rpcCircuit);
  services.register("hasuraCircuit", hasuraCircuit);
  services.register("tierManager", tierManager);

  // Reorg detector
  const reorgDetector = new ReorgDetector(publicClient, 10);

  // WebSocket subscriber
  let wsSubscriber: WebSocketSubscriber | undefined;
  if (config.mempool.websocketUrl) {
    wsSubscriber = new WebSocketSubscriber({
      url: config.mempool.websocketUrl,
      maxPendingTxsPerTick: 10,
      reconnectDelayMs: 5_000,
      pingIntervalMs: 15_000,
    });
  }

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
    getPools,
    publicClient,
    isRunning: true,
    gasOracle,
    crossChainScanner,
    solverBot,
    metrics,
    services,
    rpcCircuit,
    hasuraCircuit,
    tierManager,
    reorgDetector,
    wsSubscriber,
    dryRunner,
    graphUpdater,
  };
}
