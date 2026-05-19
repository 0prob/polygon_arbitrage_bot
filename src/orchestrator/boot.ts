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
import { fetchV2Pools } from "../services/discovery/v2_discovery.ts";
import { discoverV3Pools } from "../services/discovery/v3_discovery.ts";
import { WatcherService, type WatcherRefreshFns } from "../services/watcher/service.ts";
import type { WatcherPoolMeta, HyperSyncLogLike } from "../services/watcher/types.ts";
import { mergeStateIntoCache } from "../services/watcher/state_ops.ts";
import { createDbRollbackRegistry } from "../services/watcher/reorg.ts";
import { setHypersyncDefaults, client as hypersyncClient } from "../infra/hypersync/client.ts";
import { computeTopic0 } from "../infra/hypersync/query.ts";
import type { HyperSyncLog } from "../infra/hypersync/types.ts";
import { HydrationService, type PoolStateFetcher } from "../services/hydration/service.ts";
import { ExecutionService } from "../services/execution/service.ts";
import { GasOracle, type GasOracleConfig } from "../services/execution/gas.ts";
import { NonceManager } from "../services/execution/nonce.ts";
import { MempoolService, type MempoolServiceOptions } from "../services/mempool/service.ts";
import {
  QUICKSWAP_V2_FACTORY,
  SUSHISWAP_V2_FACTORY,
  UNISWAP_V2_FACTORY,
  DFYN_V2_FACTORY,
  APESWAP_V2_FACTORY,
  MESHSWAP_V2_FACTORY,
  JETSWAP_V2_FACTORY,
  COMETHSWAP_V2_FACTORY,
  UNISWAP_V3_FACTORY,
  SUSHISWAP_V3_FACTORY,
  QUICKSWAP_V3_FACTORY,
  KYBERSWAP_ELASTIC_FACTORY,
  BALANCER_VAULT,
} from "../config/addresses.ts";
import { getAllPoolStates, getPoolState as getPoolStateFromDb } from "../infra/db/pools.ts";

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
  const previousStates = getAllPoolStates(db);
  for (const ps of previousStates) {
    if (ps.state_data && typeof ps.state_data === "object") {
      const state = ps.state_data as Record<string, unknown>;
      stateCache.set(ps.address.toLowerCase(), state);
    }
  }
  logger.info({ loaded: previousStates.length }, "Loaded pool state from database");

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
    fetchV2Pools: (factoryAddress: Address, protocolLabel: string) => fetchV2Pools(publicClient, factoryAddress, protocolLabel),
    discoverV3Pools: (factoryAddresses: Address[]) => discoverV3Pools(hypersyncClient, factoryAddresses),
    savePool,
    v2Factories: [
      { address: QUICKSWAP_V2_FACTORY, label: "quickswap_v2" },
      { address: SUSHISWAP_V2_FACTORY, label: "sushiswap_v2" },
      { address: UNISWAP_V2_FACTORY, label: "uniswap_v2" },
      { address: DFYN_V2_FACTORY, label: "dfyn_v2" },
      { address: APESWAP_V2_FACTORY, label: "apeswap_v2" },
      { address: MESHSWAP_V2_FACTORY, label: "meshswap_v2" },
      { address: JETSWAP_V2_FACTORY, label: "jetswap_v2" },
      { address: COMETHSWAP_V2_FACTORY, label: "comethswap_v2" },
    ],
    v3FactoryAddresses: [
      UNISWAP_V3_FACTORY,
      SUSHISWAP_V3_FACTORY,
      QUICKSWAP_V3_FACTORY,
      KYBERSWAP_ELASTIC_FACTORY,
    ] as Address[],
    balancerVaultAddress: BALANCER_VAULT,
  };
  const discoveryService = new DiscoveryService(discoveryDeps);

  setHypersyncDefaults(config.hypersync.url, config.envioApiToken);
  const watcherRegistry = createDbRollbackRegistry(db);

  const v3Slot0Abi = [
    { type: "function", name: "slot0", inputs: [], outputs: [{ type: "uint160" }, { type: "int24" }], stateMutability: "view" },
  ] as const;
  const v3LiquidityAbi = [
    { type: "function", name: "liquidity", inputs: [], outputs: [{ type: "uint128" }], stateMutability: "view" },
  ] as const;

  const v2GetReservesAbi = [
    { type: "function", name: "getReserves", inputs: [], outputs: [{ type: "uint112" }, { type: "uint112" }, { type: "uint32" }], stateMutability: "view" },
  ] as const;

  const erc20DecimalsAbi = [
    { type: "function", name: "decimals", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
  ] as const;

  const tokenDecimalsCache = new Map<string, number>();

  async function fetchTokenDecimals(tokenAddresses: Address[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    const uncached = tokenAddresses.filter((a) => !tokenDecimalsCache.has(a.toLowerCase()));
    if (uncached.length > 0) {
      const results = await Promise.allSettled(
        uncached.map((addr) =>
          publicClient.readContract({ address: addr, abi: erc20DecimalsAbi, functionName: "decimals" }).then((d) => [addr.toLowerCase(), Number(d)] as const),
        ),
      );
      for (const r of results) {
        if (r.status === "fulfilled") {
          const [addr, decimals] = r.value;
          tokenDecimalsCache.set(addr, decimals);
        }
      }
    }
    for (const addr of tokenAddresses) {
      const d = tokenDecimalsCache.get(addr.toLowerCase());
      if (d != null) result.set(addr.toLowerCase(), d);
    }
    return result;
  }

  const watcherRefreshFns: WatcherRefreshFns = {
    refreshBalancer: async (addr: string, _pool: WatcherPoolMeta | null) => {
      logger.debug({ addr }, "Balancer refresh not implemented");
    },
    refreshCurve: async (addr: string, _pool: WatcherPoolMeta | null) => {
      logger.debug({ addr }, "Curve refresh not implemented");
    },
    refreshDodo: async (addr: string, _pool: WatcherPoolMeta | null) => {
      logger.debug({ addr }, "Dodo refresh not implemented");
    },
    refreshWoofi: async (addr: string, _pool: WatcherPoolMeta | null) => {
      logger.debug({ addr }, "Woofi refresh not implemented");
    },
    refreshV3: async (addr: string, _pool: WatcherPoolMeta | null, _rawLog?: HyperSyncLogLike) => {
      try {
        const address = addr as Address;
        const slot0Result = await publicClient.readContract({ address, abi: v3Slot0Abi, functionName: "slot0" });
        const [sqrtPriceX96, tick] = slot0Result as [bigint, number];
        const liquidity = (await publicClient.readContract({ address, abi: v3LiquidityAbi, functionName: "liquidity" })) as bigint;
        mergeStateIntoCache(stateCache, addr, { sqrtPriceX96, tick, liquidity, initialized: true });
      } catch (err) {
        logger.warn({ err, addr }, "V3 pool refresh failed");
      }
    },
  };

  async function refreshV2PoolState(addr: string) {
    try {
      const address = addr as Address;
      const reserves = await publicClient.readContract({ address, abi: v2GetReservesAbi, functionName: "getReserves" });
      const [reserve0, reserve1] = reserves as [bigint, bigint, number];
      mergeStateIntoCache(stateCache, addr, { reserve0, reserve1 });
    } catch {
      // pool may not exist or query timed out — skip
    }
  }

  const watcherService = new WatcherService(db, stateCache, watcherRegistry, watcherRefreshFns);

  const fetchPoolState: PoolStateFetcher = async (address, protocol, token0, token1) => {
    const addr = address.toLowerCase();
    const cached = stateCache.get(addr);
    if (cached != null && typeof cached === "object") {
      const hasReserves = "reserve0" in cached && "reserve1" in cached;
      const hasV3 = "sqrtPriceX96" in cached && "liquidity" in cached;
      if (hasReserves || hasV3) return cached;
    }
    const fromDb = getPoolStateFromDb(db, addr);
    if (fromDb?.state_data) {
      stateCache.set(addr, fromDb.state_data as Record<string, unknown>);
      return fromDb.state_data as Record<string, unknown>;
    }
    if (protocol.toUpperCase().includes("V2")) {
      await refreshV2PoolState(addr);
      const refreshed = stateCache.get(addr);
      if (refreshed) return refreshed as Record<string, unknown>;
    }
    logger.debug({ address, protocol, token0, token1 }, "No cached state for pool");
    return { reserve0: 0n, reserve1: 0n };
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
    const count = await publicClient.getTransactionCount({ address: address as `0x${string}`, blockTag: "pending" });
    return Number(count);
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

  // Trigger pool discovery for all protocols
  await discoveryService.discoverAll().catch((err) => logger.error({ err }, "Full discovery failed"));

  // Fetch token decimals for pricing
  const allPools = getPools();
  const allTokenAddresses = [...new Set(allPools.flatMap((p) => [p.token0, p.token1].filter(Boolean)))];
  const tokenDecimals = await fetchTokenDecimals(allTokenAddresses as Address[]);
  logger.info({ decimalsFetched: tokenDecimals.size }, "Token decimals cached");

  await hydrationService.warmup(config.discovery.hubTokens as Address[]);
  hydrationService.startSweep();

  const poolAddresses = getPools().map((p) => p.address);
  watcherService.start(poolAddresses.map((a) => a as string));
  logger.info({ poolCount: poolAddresses.length }, "Watcher started with pool addresses");

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
