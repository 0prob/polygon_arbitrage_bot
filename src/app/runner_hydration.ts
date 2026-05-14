import { createDiscoveryCoordinator, type DiscoveryResult } from "../arb/discovery_coordinator.ts";
import { createWarmupManager, isSupportedWarmupProtocol, type PoolRecord, type WarmupRegistry } from "../state/warmup.ts";
import {
  DISCOVERY_INTERVAL_MS,
  ENRICH_CONCURRENCY,
  MAX_SYNC_WARMUP_ONE_HUB_POOLS,
  MAX_SYNC_WARMUP_ONE_HUB_V3_POOLS,
  MAX_SYNC_WARMUP_POOLS,
  MAX_SYNC_WARMUP_V3_POOLS,
  QUIET_POOL_SWEEP_BATCH_SIZE,
  QUIET_POOL_SWEEP_CATCHUP_BATCH_SIZE,
  QUIET_POOL_SWEEP_CATCHUP_THRESHOLD,
  QUIET_POOL_SWEEP_INTERVAL_MS,
  V2_POLL_CONCURRENCY,
  V3_NEARBY_WORD_RADIUS,
  V3_POLL_CONCURRENCY,
} from "../config/index.ts";
import type { RegistryRepositories } from "../db/repositories.ts";
import { discoverPools as defaultDiscoverPools } from "../arb/discover.ts";
import { throttledMap as defaultThrottledMap } from "../state/enrichment/rpc.ts";
import { createDiscoveryRefreshCoordinator } from "../app/runner.ts";
import { createQuietPoolSweepCoordinator } from "../app/quiet_pool_sweep.ts";
import { HUB_4_TOKENS, POLYGON_HUB_TOKENS } from "../routing/graph.ts";
import { fetchAndNormalizeBalancerPool as defaultFetchAndNormalizeBalancerPool } from "../state/poll_balancer.ts";
import { fetchAndNormalizeCurvePool as defaultFetchAndNormalizeCurvePool } from "../state/poll_curve.ts";
import { fetchAndNormalizeDodoPool as defaultFetchAndNormalizeDodoPool } from "../state/poll_dodo.ts";
import { fetchAndNormalizeWoofiPool as defaultFetchAndNormalizeWoofiPool } from "../state/poll_woofi.ts";
import { normalizePoolState as defaultNormalizePoolState, validatePoolState as defaultValidatePoolState } from "../state/normalizer.ts";
import { fetchMultipleV2States as defaultFetchMultipleV2States, type V2FetchOptions, type V2StateMap } from "../state/uniswap_v2.ts";
import { fetchMultipleV3States as defaultFetchMultipleV3States } from "../state/uniswap_v3.ts";
import type { V3FetchOptions, V3PoolMeta, V3PoolState, V3StateMap } from "../state/uniswap_v3.ts";
import { getPoolMetadata as defaultGetPoolMetadata, getPoolTokens as defaultGetPoolTokens } from "../utils/pool_record.ts";
import { routeConsoleOutputToLog } from "./helpers.ts";

type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";
type LoggerFn = (msg: string, level?: LogLevel, meta?: unknown) => void;
type PoolState = Record<string, unknown>;
type StateCache = Map<string, PoolState>;
const DEFAULT_QUIET_POOL_RETRY_BASE_MS = 2 * 60_000;
const DEFAULT_QUIET_POOL_RETRY_MAX_MS = 30 * 60_000;

type WatcherLike = {
  addPools: (poolAddresses: string[]) => Promise<unknown>;
  backfillPools?: (poolAddresses: string[]) => Promise<unknown>;
};

type FetchAndCacheOptions = {
  v3HydrationMode?: "full" | "nearby" | "none" | "tiered";
  v3NearWordRadius?: number;
  blockTag?: "latest" | "pending";
  logContext?: {
    label: string;
    eventPrefix: string;
  };
};

type RunnerHydrationAdaptersDeps = {
  discoverPools?: () => Promise<DiscoveryResult>;
  discoveryOutputMode?: "console" | "log";
  getRegistry: () => WarmupRegistry | null | undefined;
  getRepositories: () => RegistryRepositories | null | undefined;
  getWatcher: () => WatcherLike | null | undefined;
  isRunning: () => boolean;
  stateCache: StateCache;
  log: LoggerFn;
  getPoolTokens?: (pool: PoolRecord) => string[];
  getPoolMetadata?: (pool: PoolRecord) => Record<string, unknown>;
  validatePoolState?: (state: unknown) => { valid: boolean; reason?: string };
  normalizePoolState?: (addr: string, protocol: string, tokens: string[], raw: unknown, metadata?: unknown) => PoolState | null;
  fetchMultipleV2States?: (addresses: string[], concurrency: number, options?: V2FetchOptions) => Promise<V2StateMap>;
  fetchMultipleV3States?: (
    addresses: string[],
    concurrency: number,
    poolMeta: Map<string, V3PoolMeta>,
    onProgress: (completed: number, total: number, addr: string, rawState: V3PoolState | null) => void,
    fetchOptions?: V3FetchOptions,
  ) => Promise<V3StateMap>;
  fetchAndNormalizeBalancerPool?: (pool: PoolRecord) => Promise<{ addr: string; normalized: PoolState }>;
  fetchAndNormalizeCurvePool?: (pool: PoolRecord) => Promise<{ addr: string; normalized: PoolState }>;
  fetchAndNormalizeDodoPool?: (pool: PoolRecord) => Promise<{ addr: string; normalized: PoolState }>;
  fetchAndNormalizeWoofiPool?: (pool: PoolRecord) => Promise<{ addr: string; normalized: PoolState }>;
  throttledMap?: <T, R>(items: T[], mapper: (item: T) => Promise<R>, concurrency: number) => Promise<R[]>;
  getActivePoolMeta: () => PoolRecord[];
  admitPools: (poolAddresses: Set<string>) => number;
  invalidateTopology: (reason?: string) => void;
  refreshCycles: (force?: boolean) => Promise<unknown>;
  polygonHubTokens?: Set<string>;
  hub4Tokens?: Set<string>;
  maxSyncWarmupPools?: number;
  maxSyncWarmupV3Pools?: number;
  maxSyncWarmupOneHubPools?: number;
  maxSyncWarmupOneHubV3Pools?: number;
  v2PollConcurrency?: number;
  v3PollConcurrency?: number;
  enrichConcurrency?: number;
  discoveryIntervalMs?: number;
  quietPoolSweepBatchSize?: number;
  quietPoolSweepCatchupBatchSize?: number;
  quietPoolSweepCatchupThreshold?: number;
  quietPoolSweepIntervalMs?: number;
  quietPoolRetryBaseMs?: number;
  quietPoolRetryMaxMs?: number;
  v3NearWordRadius?: number;
};

export function createRunnerHydrationAdapters(deps: RunnerHydrationAdaptersDeps) {
  const getPoolTokens = deps.getPoolTokens ?? defaultGetPoolTokens;
  const getPoolMetadata = deps.getPoolMetadata ?? defaultGetPoolMetadata;
  const fetchMultipleV2States = deps.fetchMultipleV2States ?? defaultFetchMultipleV2States;
  const fetchMultipleV3States = deps.fetchMultipleV3States ?? defaultFetchMultipleV3States;
  const fetchAndNormalizeBalancerPool = deps.fetchAndNormalizeBalancerPool ?? defaultFetchAndNormalizeBalancerPool;
  const fetchAndNormalizeCurvePool = deps.fetchAndNormalizeCurvePool ?? defaultFetchAndNormalizeCurvePool;
  const fetchAndNormalizeDodoPool = deps.fetchAndNormalizeDodoPool ?? defaultFetchAndNormalizeDodoPool;
  const fetchAndNormalizeWoofiPool = deps.fetchAndNormalizeWoofiPool ?? defaultFetchAndNormalizeWoofiPool;
  const throttledMap = deps.throttledMap ?? defaultThrottledMap;
  const polygonHubTokens = deps.polygonHubTokens ?? POLYGON_HUB_TOKENS;
  const hub4Tokens = deps.hub4Tokens ?? HUB_4_TOKENS;
  const validatePoolState = deps.validatePoolState ?? defaultValidatePoolState;
  const normalizePoolState = deps.normalizePoolState ?? defaultNormalizePoolState;
  const v3NearWordRadius = deps.v3NearWordRadius ?? V3_NEARBY_WORD_RADIUS;
  const discoverPools = deps.discoverPools ?? defaultDiscoverPools;
  const runDiscoverPools =
    deps.discoveryOutputMode === "log" ? () => routeConsoleOutputToLog(discoverPools, deps.log, "discovery_console") : discoverPools;
  const warmupManager = createWarmupManager({
    getRegistry: deps.getRegistry,
    stateCache: deps.stateCache,
    log: deps.log,
    getPoolTokens,
    getPoolMetadata,
    validatePoolState,
    normalizePoolState,
    fetchMultipleV2States,
    fetchMultipleV3States,
    fetchAndNormalizeBalancerPool,
    fetchAndNormalizeCurvePool,
    fetchAndNormalizeDodoPool,
    fetchAndNormalizeWoofiPool,
    throttledMap,
    polygonHubTokens,
    hub4Tokens,
    maxSyncWarmupPools: deps.maxSyncWarmupPools ?? MAX_SYNC_WARMUP_POOLS,
    maxSyncWarmupV3Pools: deps.maxSyncWarmupV3Pools ?? MAX_SYNC_WARMUP_V3_POOLS,
    maxSyncWarmupOneHubPools: deps.maxSyncWarmupOneHubPools ?? MAX_SYNC_WARMUP_ONE_HUB_POOLS,
    maxSyncWarmupOneHubV3Pools: deps.maxSyncWarmupOneHubV3Pools ?? MAX_SYNC_WARMUP_ONE_HUB_V3_POOLS,
    v2PollConcurrency: deps.v2PollConcurrency ?? V2_POLL_CONCURRENCY,
    v3PollConcurrency: deps.v3PollConcurrency ?? V3_POLL_CONCURRENCY,
    enrichConcurrency: deps.enrichConcurrency ?? ENRICH_CONCURRENCY,
  });

  const discoveryCoordinator = createDiscoveryCoordinator({
    discoverPools: runDiscoverPools,
    log: deps.log,
    discoveryIntervalMs: deps.discoveryIntervalMs ?? DISCOVERY_INTERVAL_MS,
  });

  const quietPoolSweepCoordinator = createQuietPoolSweepCoordinator({
    getRegistryPools: deps.getActivePoolMeta,
    stateCache: deps.stateCache,
    log: deps.log,
    isHydratablePool: (pool: PoolRecord) => isSupportedWarmupProtocol(pool.protocol),
    validatePoolState,
    fetchAndCacheStates: (pools: PoolRecord[], options: FetchAndCacheOptions) => warmupManager.fetchAndCacheStates(pools, options),
    admitPools: deps.admitPools,
    refreshCycles: deps.refreshCycles,
    quietPoolSweepBatchSize: deps.quietPoolSweepBatchSize ?? QUIET_POOL_SWEEP_BATCH_SIZE,
    quietPoolSweepCatchupBatchSize: deps.quietPoolSweepCatchupBatchSize ?? QUIET_POOL_SWEEP_CATCHUP_BATCH_SIZE,
    quietPoolSweepCatchupThreshold: deps.quietPoolSweepCatchupThreshold ?? QUIET_POOL_SWEEP_CATCHUP_THRESHOLD,
    quietPoolSweepIntervalMs: deps.quietPoolSweepIntervalMs ?? QUIET_POOL_SWEEP_INTERVAL_MS,
    quietPoolRetryBaseMs: deps.quietPoolRetryBaseMs ?? DEFAULT_QUIET_POOL_RETRY_BASE_MS,
    quietPoolRetryMaxMs: deps.quietPoolRetryMaxMs ?? DEFAULT_QUIET_POOL_RETRY_MAX_MS,
    v3NearWordRadius,
    polygonHubTokens,
    hub4Tokens,
  });

  const discoveryRefreshCoordinator = createDiscoveryRefreshCoordinator({
    isRunning: deps.isRunning,
    log: deps.log,
    getRepositories: () => deps.getRepositories() ?? null,
    stateCache: deps.stateCache,
    getWatcher: deps.getWatcher,
    isHydratablePool: (pool: any) => isSupportedWarmupProtocol(pool.protocol),
    claimDeferredHydration: (pools: any[]) => quietPoolSweepCoordinator.claimDeferredHydration(pools),
    releaseDeferredHydration: (pools: any[]) => quietPoolSweepCoordinator.releaseDeferredHydration(pools),
    fetchAndCacheStates: (pools: any[], options: FetchAndCacheOptions) => warmupManager.fetchAndCacheStates(pools, options),
    validatePoolState,
    clearDeferredHydrationRetry: (address: string) => quietPoolSweepCoordinator.clearDeferredHydrationRetry(address),
    recordDeferredHydrationFailure: (address: string, reason: string) =>
      quietPoolSweepCoordinator.recordDeferredHydrationFailure(address, reason),
    topology: {
      invalidate: deps.invalidateTopology,
    },
    refreshCycles: deps.refreshCycles,
    v3NearWordRadius,
  });

  return {
    warmupManager,
    discoveryCoordinator,
    quietPoolSweepCoordinator,
    discoveryRefreshCoordinator,
    seedStateCache: warmupManager.seedStateCache,
    warmupStateCache: warmupManager.warmupStateCache,
    fetchAndCacheStates: warmupManager.fetchAndCacheStates,
    maybeRunDiscovery: discoveryCoordinator.maybeRunDiscovery,
    runInitialDiscovery: discoveryCoordinator.runInitialDiscovery,
    maybeHydrateQuietPools: quietPoolSweepCoordinator.maybeHydrateQuietPools,
    reconcileDiscoveryResult: discoveryRefreshCoordinator.reconcileDiscoveryResult,
  };
}
