import path from "path";
import { type PublicClient } from "viem";
import type { AppConfig } from "../config/schema.ts";
import { createRootLogger, type Logger } from "../infra/observability/logger.ts";
import { createDatabase, type CompatDatabase } from "../infra/db/connection.ts";
import { ensureSchema } from "../infra/db/schema.ts";
import type { RouteStateCache } from "../core/types/route.ts";
import type { PoolMeta } from "../core/types/pool.ts";
import type { Address } from "../core/types/common.ts";
import { ExecutionService } from "../services/execution/service.ts";
import { GasOracle, type GasOracleConfig } from "../services/execution/gas.ts";
import { NonceManager } from "../services/execution/nonce.ts";
import { MempoolService, type MempoolServiceOptions } from "../services/mempool/service.ts";
import { getRecentPoolStates } from "../infra/db/pools.ts";
import { getHiDbPath, readHyperIndexPools } from "../infra/db/hyperindex_reader.ts";
import { CrossChainScanner } from "../services/crosschain/scanner.ts";
import { SolverBot } from "../services/crosschain/solver.ts";
import { createReadClient, createExecutionClient } from "../infra/rpc/client_factory.ts";

export interface RuntimeContext {
  config: AppConfig;
  logger: Logger;
  db: CompatDatabase;
  stateCache: RouteStateCache;
  hiDbPath: string;
  executionService: ExecutionService;
  mempoolService: MempoolService;
  getPools: () => PoolMeta[];
  publicClient: PublicClient;
  isRunning: boolean;
  gasOracle: GasOracle;
  crossChainScanner?: CrossChainScanner;
  solverBot?: SolverBot;
  watcherService?: any;
  hydrationService?: any;
  discoveryService?: any;
}

export async function bootApplication(config: AppConfig, logBuffer?: string[]): Promise<RuntimeContext> {
  const logger = createRootLogger({
    level: config.observability.logLevel,
    logSink: logBuffer,
  });

  const dbPath = path.join(config.paths.dataDir, config.paths.dbFile);
  const db = createDatabase(dbPath);
  ensureSchema(db);

  // Optimized read client with fallback and batching
  const publicClient = createReadClient(config.rpc.polygonRpcUrls, {
    chainId: 137,
    timeoutMs: config.rpc.requestTimeoutMs,
    batchSize: config.rpc.batchSize,
    batchWaitMs: config.rpc.batchWaitMs,
  });

  const stateCache: RouteStateCache = new Map();
  const previousStates = getRecentPoolStates(db, 5000);
  for (const ps of previousStates) {
    if (ps.state_data && typeof ps.state_data === "object") {
      const state = ps.state_data as Record<string, unknown>;
      stateCache.set(ps.address.toLowerCase(), state);
    }
  }
  logger.info({ loaded: previousStates.length }, "Loaded pool state from database");

  let cachedPools: PoolMeta[] | null = null;
  let lastPoolFetch = 0;

  const getPools = (): PoolMeta[] => {
    if (cachedPools && Date.now() - lastPoolFetch < 60_000) {
      return cachedPools;
    }

    const rows = db.prepare("SELECT address, protocol, tokens FROM pools WHERE status = 'active'").all() as Array<{
      address: string; protocol: string; tokens: string;
    }>;
    const seen = new Set(rows.map(r => r.address));

    try {
      const hiPools = readHyperIndexPools(config.paths.dataDir);
      for (const p of hiPools) {
        if (!seen.has(p.address)) {
          rows.push({ address: p.address, protocol: p.protocol, tokens: p.tokens });
          seen.add(p.address);
        }
      }
    } catch { /* HyperIndex DB may not exist yet */ }

    const pools = rows.map((r) => {
      let tokens: string[];
      try { tokens = JSON.parse(r.tokens); } catch { tokens = []; }
      return {
        address: r.address as Address,
        protocol: r.protocol,
        token0: (tokens[0] ?? "") as Address,
        token1: (tokens[1] ?? "") as Address,
        tokens: tokens as Address[],
      };
    });

    cachedPools = pools;
    lastPoolFetch = Date.now();
    return pools;
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

  // Optimized execution client
  const submitTx = async (tx: { to: string; data: string; value: bigint; nonce: number; maxFee: bigint }): Promise<string> => {
    const walletClient = createExecutionClient(config.rpc.executionRpcUrl, config.execution.privateKey, 137);
    if (!walletClient.account) {
      throw new Error("Execution client is not configured with an account.");
    }
    const hash = await walletClient.sendTransaction({
      account: walletClient.account,
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

  const executionService = new ExecutionService(logger, gasOracle, nonceManager, submitTx);

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
      polygonRpcUrl: config.rpc.polygonRpcUrls[0], // Use first available
      katanaRpcUrl: config.crossChainArb.katanaRpcUrl,
    });
  }

  logger.info("Ready — entering pass loop");

  return {
    config,
    logger,
    db,
    stateCache,
    hiDbPath: getHiDbPath(config.paths.dataDir),
    executionService,
    mempoolService,
    getPools,
    publicClient,
    isRunning: true,
    gasOracle,
    crossChainScanner,
    solverBot,
  };
}
