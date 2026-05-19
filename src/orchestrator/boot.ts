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
import { decodePairCreated, decodePoolRegistered, decodePoolDeployed, decodeCurvePoolAdded, type DecodedPoolEvent } from "../services/discovery/decoder.ts";
import type { TokenMetaFetcher } from "../services/discovery/enrichment.ts";
import { fetchCurvePools } from "../services/discovery/curve_discovery.ts";
import { WatcherService } from "../services/watcher/service.ts";
import { createDbRollbackRegistry } from "../services/watcher/reorg.ts";
import { setHypersyncDefaults } from "../infra/hypersync/client.ts";
import { computeTopic0 } from "../infra/hypersync/query.ts";
import type { HyperSyncLog } from "../infra/hypersync/types.ts";
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

  const DISCOVERY_SIGNATURES: Record<string, (log: HyperSyncLog) => DecodedPoolEvent | null> = {
    [computeTopic0("event PairCreated(address indexed token0, address indexed token1, address pair, uint256)")]: decodePairCreated,
    [computeTopic0("event PoolRegistered(bytes32 indexed poolId, address indexed poolAddress, uint256 specialization)")]: decodePoolRegistered,
    [computeTopic0("event PoolDeployed(address indexed token0, address indexed token1, uint256 pool)")]: decodePoolDeployed,
    [computeTopic0("event PoolAdded(address indexed pool)")]: decodeCurvePoolAdded,
  };

  const decodeLog = (logs: unknown[]): DecodedPoolEvent[] => {
    const results: DecodedPoolEvent[] = [];
    for (const raw of logs) {
      const log = raw as HyperSyncLog;
      const topic0 = log.topics?.[0] ?? "";
      const decoder = DISCOVERY_SIGNATURES[topic0.toLowerCase()];
      if (decoder) {
        const decoded = decoder(log);
        if (decoded) results.push(decoded);
      }
    }
    return results;
  };

  const fetchTokenMeta: TokenMetaFetcher = async (_tokenAddresses) => {
    return new Map();
  };

  const fetchCurvePoolsImpl = async (factoryAddress: Address) => {
    return await fetchCurvePools(publicClient, factoryAddress);
  };

  const savePool = async (pool: { address: Address; protocol: string; tokens: Address[] }): Promise<void> => {
    const stmt = db.prepare(
      "INSERT OR REPLACE INTO pools (address, protocol, tokens, created_block, created_tx, metadata, status) VALUES (?, ?, ?, 0, '', '{}', 'active')",
    );
    stmt.run(pool.address.toLowerCase(), pool.protocol, JSON.stringify(pool.tokens.map((t: Address) => t.toLowerCase())));
  };

  const discoveryDeps: DiscoveryServiceDeps = {
    logger,
    decodeLog,
    fetchTokenMeta,
    fetchCurvePools: fetchCurvePoolsImpl,
    savePool,
  };
  const discoveryService = new DiscoveryService(discoveryDeps);

  setHypersyncDefaults(config.hypersync.url, config.envioApiToken);
  const watcherRegistry = createDbRollbackRegistry(db);
  const watcherService = new WatcherService(db, stateCache, watcherRegistry);

  const fetchPoolState: PoolStateFetcher = async (address, protocol, token0, token1) => {
    // Placeholder implementation: In a real scenario, this would fetch actual pool state from the blockchain
    // For now, return a dummy state to unblock hydration
    logger.debug({ address, protocol, token0, token1 }, "Fetching pool state (placeholder)");
    return { reserve0: 1000n, reserve1: 1000n, extra: {} };
  };

  const getPools = (): PoolMeta[] => {
    try {
      const rows = db.prepare("SELECT address, protocol, tokens FROM pools WHERE status = 'active'").all() as Array<{
        address: string;
        protocol: string;
        tokens: string;
      }>;
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

  const pk = config.execution.privateKey.startsWith("0x") ? config.execution.privateKey : `0x${config.execution.privateKey}`;
  const account = privateKeyToAccount(pk as `0x${string}`);
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

  // Trigger pool discovery and await before hydration
  await Promise.all([
    discoveryService.discoverProtocol("balancer").catch((err) => logger.error(err)),
    discoveryService.discoverProtocol("curve").catch((err) => logger.error(err)),
  ]);

  await hydrationService.warmup(config.discovery.hubTokens as Address[]);
  hydrationService.startSweep();

  watcherService.start();

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
