import path from "path";
import { createPublicClient, createWalletClient, http, type PublicClient } from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import type { AppConfig } from "../config/schema.ts";
import { createRootLogger, type Logger } from "../infra/observability/logger.ts";
import { createDatabase, type CompatDatabase } from "../infra/db/connection.ts";
import { ensureSchema } from "../infra/db/schema.ts";
import type { RouteStateCache } from "../core/types/route.ts";
import type { PoolMeta } from "../core/types/pool.ts";
import type { Address } from "../core/types/common.ts";
import { DiscoveryService, type DiscoveryServiceDeps } from "../services/discovery/service.ts";
import type { DecodedPoolEvent } from "../services/discovery/decoder.ts";
import type { TokenMetaFetcher } from "../services/discovery/enrichment.ts";
import type { CurveFactoryFetcher } from "../services/discovery/curve_factory.ts";
import { WatcherService } from "../services/watcher/service.ts";
import { HydrationService, type PoolStateFetcher } from "../services/hydration/service.ts";
import { ExecutionService } from "../services/execution/service.ts";
import { GasOracle, type GasOracleConfig } from "../services/execution/gas.ts";
import { NonceManager } from "../services/execution/nonce.ts";
import { MempoolService, type MempoolServiceOptions } from "../services/mempool/service.ts";

export interface RuntimeContext {
  config: AppConfig;
  logger: Logger;
  db: CompatDatabase;
  stateCache: RouteStateCache;
  discoveryService: DiscoveryService;
  watcherService: WatcherService;
  hydrationService: HydrationService;
  executionService: ExecutionService;
  mempoolService: MempoolService;
  getPools: () => PoolMeta[];
  publicClient: PublicClient;
  isRunning: boolean;
}

export async function bootApplication(config: AppConfig, logBuffer?: string[]): Promise<RuntimeContext> {
  const logger = createRootLogger({
    level: config.observability.logLevel,
    logSink: logBuffer,
  });

  const dbPath = path.join(config.paths.dataDir, config.paths.dbFile);
  const db = createDatabase(dbPath);
  ensureSchema(db);

  const publicClient = createPublicClient({
    chain: polygon,
    transport: http(config.rpc.polygonRpcUrls[0], {
      timeout: config.rpc.requestTimeoutMs,
      batch: { batchSize: config.rpc.batchSize },
    }),
    batch: { multicall: { wait: config.rpc.batchWaitMs, batchSize: config.rpc.batchSize } },
  });

  const stateCache: RouteStateCache = new Map();

  const decodeLog = (_logs: unknown[]): DecodedPoolEvent[] => {
    return [];
  };

  const fetchTokenMeta: TokenMetaFetcher = async (_tokenAddresses) => {
    return new Map();
  };

  const fetchCurvePools: CurveFactoryFetcher = async (_factoryAddress) => {
    return [];
  };

  const savePool = async (pool: { address: Address; protocol: string; tokens: Address[] }): Promise<void> => {
    const stmt = db.prepare(
      "INSERT OR REPLACE INTO pools (address, protocol, tokens, created_block, created_tx, metadata, status) VALUES (?, ?, ?, 0, '', '{}', 'active')",
    );
    stmt.run(
      pool.address.toLowerCase(),
      pool.protocol,
      JSON.stringify(pool.tokens.map((t: Address) => t.toLowerCase())),
    );
  };

  const discoveryDeps: DiscoveryServiceDeps = {
    logger,
    decodeLog,
    fetchTokenMeta,
    fetchCurvePools,
    savePool,
  };
  const discoveryService = new DiscoveryService(discoveryDeps);

  const watcherRegistry = {};
  const watcherService = new WatcherService(db, stateCache, watcherRegistry);

  const fetchPoolState: PoolStateFetcher = async (_address, _protocol, _token0, _token1) => {
    return null;
  };

  const getPools = (): PoolMeta[] => {
    try {
      const rows = db.prepare(
        "SELECT address, protocol, tokens FROM pools WHERE status = 'active'",
      ).all() as Array<{ address: string; protocol: string; tokens: string }>;
      return rows.map((r) => {
        let tokens: string[];
        try {
          tokens = JSON.parse(r.tokens);
        } catch {
          tokens = [];
        }
        return {
          address: r.address as Address,
          protocol: r.protocol,
          token0: (tokens[0] ?? "") as Address,
          token1: (tokens[1] ?? "") as Address,
          tokens: tokens as Address[],
        };
      });
    } catch {
      return [];
    }
  };

  const hydrationService = new HydrationService(logger, stateCache, fetchPoolState, getPools);

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
    try {
      return Number(await publicClient.getTransactionCount({ address: address as `0x${string}`, blockTag: "pending" }));
    } catch {
      return 0;
    }
  };

  const nonceManager = new NonceManager(config.execution.executorAddress, nonceFetcher);

  const account = privateKeyToAccount(config.execution.privateKey as `0x${string}`);
  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http(config.rpc.executionRpcUrl, { timeout: config.rpc.requestTimeoutMs }),
  });

  const submitTx = async (tx: { to: string; data: string; value: bigint; nonce: number; maxFee: bigint }): Promise<string> => {
    const hash = await walletClient.sendTransaction({
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

  return {
    config,
    logger,
    db,
    stateCache,
    discoveryService,
    watcherService,
    hydrationService,
    executionService,
    mempoolService,
    getPools,
    publicClient,
    isRunning: true,
  };
}
