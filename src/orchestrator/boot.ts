import { type PublicClient } from "viem";
import type { AppConfig } from "../config/schema.ts";
import { createRootLogger, type Logger } from "../infra/observability/logger.ts";
import type { RouteStateCache } from "../core/types/route.ts";
import type { PoolMeta } from "../core/types/pool.ts";
import { ExecutionService } from "../services/execution/service.ts";
import { GasOracle, type GasOracleConfig } from "../services/execution/gas.ts";
import { NonceManager } from "../services/execution/nonce.ts";
import { MempoolService, type MempoolServiceOptions } from "../services/mempool/service.ts";
import { CrossChainScanner } from "../services/crosschain/scanner.ts";
import { SolverBot } from "../services/crosschain/solver.ts";
import { createReadClient, createExecutionClient } from "../infra/rpc/client_factory.ts";

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
}

export async function bootApplication(config: AppConfig, logBuffer?: string[], passedLogger?: Logger): Promise<RuntimeContext> {
  const logger = passedLogger ?? createRootLogger({
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

  let cachedPools: PoolMeta[] | null = null;
  let lastPoolFetch = 0;

  const getPools = (): PoolMeta[] => {
    if (cachedPools && Date.now() - lastPoolFetch < 60_000) {
      return cachedPools;
    }
    cachedPools = [];
    lastPoolFetch = Date.now();
    return cachedPools;
  };

  const gasOracleConfig: GasOracleConfig = {
    pollIntervalMs: config.gas.pollIntervalMs,
    priorityFeeFloorGwei: config.gas.priorityFeeFloorGwei,
    priorityFeeCeilingGwei: config.gas.priorityFeeCeilingGwei,
    maxBidMultiplier: config.gas.maxBidMultiplier,
  };

  const fetchGas = async () => {
    try {
      const block = await publicClient.getBlock({ blockTag: "latest" });
      const baseFee = block.baseFeePerGas ?? 30n * 10n ** 9n;
      return { baseFee, priorityFee: 30n * 10n ** 9n };
    } catch {
      return { baseFee: 30n * 10n ** 9n, priorityFee: 30n * 10n ** 9n };
    }
  };

  const gasOracle = new GasOracle(gasOracleConfig, fetchGas);

  const nonceFetcher = async (address: string): Promise<number> => {
    const count = await publicClient.getTransactionCount({ address: address as `0x${string}`, blockTag: "pending" });
    return Number(count);
  };

  const nonceManager = new NonceManager(config.execution.executorAddress, nonceFetcher);

  const walletClients = config.execution.privateRelayUrls.length > 0
    ? config.execution.privateRelayUrls.map(url => createExecutionClient(url, config.execution.privateKey, 137))
    : [createExecutionClient(config.rpc.executionRpcUrl, config.execution.privateKey, 137)];

  walletClients.forEach(wc => {
    if (!wc.account) {
      throw new Error("Execution client is not configured with an account.");
    }
  });

  const submitters = walletClients.map(walletClient => {
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

  const executionService = new ExecutionService(logger, gasOracle, nonceManager, submitters);

  const mempoolOptions: MempoolServiceOptions = {
    coalesceTtlMs: config.mempool.coalesceTtlMs,
    largeSwapThresholdWei: 10n ** 18n,
  };
  const mempoolService = new MempoolService(logger, mempoolOptions);

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
  };
}
