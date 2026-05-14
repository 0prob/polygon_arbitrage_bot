import type { HyperSyncRawLog } from "../hypersync/logs.ts";
import { normalizeProtocolKey } from "../protocols/classification.ts";
import type { RouteState } from "../routing/simulation_types.ts";
import { normalizeV3State } from "./normalizer.ts";
import { fetchAndNormalizeBalancerPool } from "./poll_balancer.ts";
import { fetchAndNormalizeCurvePool } from "./poll_curve.ts";
import { fetchAndNormalizeDodoPool } from "./poll_dodo.ts";
import { fetchAndNormalizeWoofiPool } from "./poll_woofi.ts";
import type { ProtocolPoolRecord } from "./poller_base.ts";
import { metadataWithRegistryTokenDecimals } from "./pool_metadata.ts";
import { parsePoolTokens } from "./pool_record.ts";
import { fetchV3PoolState, type V3PoolMeta, type V3PoolState } from "./uniswap_v3.ts";
import { toMutableWatcherState } from "./watcher_normalized_state.ts";
import type { MutableWatcherState, WatcherPoolMeta, WatcherPoolRefresh, WatcherV3Refresh } from "./watcher_types.ts";

export type WatcherRefreshRegistry = {
  getTokenDecimals?: (tokens: string[]) => Map<string, number> | null | undefined;
};

export type WatcherRefreshMergeState = (addr: string, nextState: MutableWatcherState) => MutableWatcherState;

export type WatcherRefreshCommitState = (addr: string, state: MutableWatcherState, rawLog: HyperSyncRawLog) => void;

export type WatcherNormalizedStateFetcher = (
  pool: ProtocolPoolRecord,
  options: { tokenDecimals: Map<string, number> | null },
) => Promise<{ normalized: RouteState }>;

export type WatcherRefreshBaseArgs = {
  addr: string;
  pool: WatcherPoolMeta | null;
  registry: WatcherRefreshRegistry | null | undefined;
  lastBlock: number;
  mergeState: WatcherRefreshMergeState;
  commitState: WatcherRefreshCommitState;
  shouldCommit?: () => boolean;
};

export type WatcherNormalizedRefreshArgs = WatcherRefreshBaseArgs & {
  fetchNormalized: WatcherNormalizedStateFetcher;
};

export type WatcherPoolRefresher = (args: WatcherRefreshBaseArgs) => unknown | Promise<unknown>;

export type WatcherV3PoolRefresher = (args: WatcherV3RefreshArgs) => unknown | Promise<unknown>;

export type WatcherRefreshers = {
  refreshBalancer: WatcherPoolRefresher;
  refreshCurve: WatcherPoolRefresher;
  refreshDodo: WatcherPoolRefresher;
  refreshWoofi: WatcherPoolRefresher;
  refreshV3: WatcherV3PoolRefresher;
};

export type WatcherRefreshAdapterContext = {
  registry: WatcherRefreshRegistry | null | undefined;
  lastBlock: () => number;
  currentEpoch: () => number;
  isClosed: () => boolean;
  isCurrentEpoch: (epoch: number) => boolean;
  mergeState: WatcherRefreshMergeState;
  commitState: (addr: string, state: MutableWatcherState, rawLog: HyperSyncRawLog, expectedEpoch: number) => void;
};

export type WatcherRefreshAdapters = {
  refreshBalancer: WatcherPoolRefresh;
  refreshCurve: WatcherPoolRefresh;
  refreshDodo: WatcherPoolRefresh;
  refreshWoofi: WatcherPoolRefresh;
  refreshV3: WatcherV3Refresh;
};

export function watcherV3MetadataFee(value: unknown): V3PoolMeta["swapFeeBps"] {
  if (value == null) return null;
  if (typeof value === "number" || typeof value === "string" || typeof value === "bigint") return value;
  return null;
}

function canCommit(shouldCommit: (() => boolean) | undefined) {
  return shouldCommit ? shouldCommit() : true;
}

export async function refreshNormalizedWatcherPool({
  addr,
  pool,
  registry,
  lastBlock,
  fetchNormalized,
  mergeState,
  commitState,
  shouldCommit,
}: WatcherNormalizedRefreshArgs) {
  if (!pool) return;
  const tokens = parsePoolTokens(pool.tokens);
  const tokenDecimals = registry?.getTokenDecimals?.(tokens) ?? null;
  const { normalized } = await fetchNormalized(pool as ProtocolPoolRecord, { tokenDecimals });
  if (!canCommit(shouldCommit)) return;
  const state = mergeState(addr, toMutableWatcherState(normalized));
  commitState(addr, state, { blockNumber: lastBlock });
}

export function refreshBalancerWatcherPool(args: WatcherRefreshBaseArgs) {
  return refreshNormalizedWatcherPool({
    ...args,
    fetchNormalized: fetchAndNormalizeBalancerPool,
  });
}

export function refreshCurveWatcherPool(args: WatcherRefreshBaseArgs) {
  return refreshNormalizedWatcherPool({
    ...args,
    fetchNormalized: fetchAndNormalizeCurvePool,
  });
}

export function refreshDodoWatcherPool(args: WatcherRefreshBaseArgs) {
  return refreshNormalizedWatcherPool({
    ...args,
    fetchNormalized: fetchAndNormalizeDodoPool,
  });
}

export function refreshWoofiWatcherPool(args: WatcherRefreshBaseArgs) {
  return refreshNormalizedWatcherPool({
    ...args,
    fetchNormalized: fetchAndNormalizeWoofiPool,
  });
}

export type WatcherV3StateFetcher = (addr: string, options: Parameters<typeof fetchV3PoolState>[1]) => Promise<V3PoolState>;

export type WatcherV3RefreshArgs = WatcherRefreshBaseArgs & {
  rawLog?: HyperSyncRawLog | null;
  fetchState?: WatcherV3StateFetcher;
};

export async function refreshV3WatcherPool({
  addr,
  pool,
  registry,
  lastBlock,
  rawLog = null,
  fetchState = fetchV3PoolState,
  mergeState,
  commitState,
  shouldCommit,
}: WatcherV3RefreshArgs) {
  if (!pool) return;
  const tokens = parsePoolTokens(pool.tokens);
  const metadata = metadataWithRegistryTokenDecimals(registry, pool, tokens);
  const protocol = normalizeProtocolKey(pool.protocol);
  const rawState = await fetchState(addr, {
    isAlgebra: protocol === "QUICKSWAP_V3" || metadata.isAlgebra === true,
    isKyberElastic: protocol === "KYBERSWAP_ELASTIC" || metadata.isKyberElastic === true,
    swapFeeBps: watcherV3MetadataFee(metadata.swapFeeBps),
    swapFeeUnits: watcherV3MetadataFee(metadata.swapFeeUnits),
    hydrationMode: "nearby",
  });
  const normalized = normalizeV3State(addr, protocol, tokens, rawState, metadata) as RouteState;
  if (!canCommit(shouldCommit)) return;
  const state = mergeState(addr, toMutableWatcherState(normalized));
  commitState(addr, state, rawLog ?? { blockNumber: lastBlock });
}

const DEFAULT_WATCHER_REFRESHERS: WatcherRefreshers = {
  refreshBalancer: refreshBalancerWatcherPool,
  refreshCurve: refreshCurveWatcherPool,
  refreshDodo: refreshDodoWatcherPool,
  refreshWoofi: refreshWoofiWatcherPool,
  refreshV3: refreshV3WatcherPool,
};

export function createWatcherRefreshAdapters(
  context: WatcherRefreshAdapterContext,
  refreshers: Partial<WatcherRefreshers> = {},
): WatcherRefreshAdapters {
  const resolvedRefreshers = {
    ...DEFAULT_WATCHER_REFRESHERS,
    ...refreshers,
  };
  const buildBaseArgs = (): Omit<WatcherRefreshBaseArgs, "addr" | "pool"> => {
    const expectedEpoch = context.currentEpoch();
    return {
      registry: context.registry,
      lastBlock: context.lastBlock(),
      mergeState: context.mergeState,
      commitState: (addr, state, rawLog) => {
        context.commitState(addr, state, rawLog, expectedEpoch);
      },
      shouldCommit: () => !context.isClosed() && context.isCurrentEpoch(expectedEpoch),
    };
  };

  return {
    refreshBalancer: (addr, pool) =>
      resolvedRefreshers.refreshBalancer({
        ...buildBaseArgs(),
        addr,
        pool,
      }),
    refreshCurve: (addr, pool) =>
      resolvedRefreshers.refreshCurve({
        ...buildBaseArgs(),
        addr,
        pool,
      }),
    refreshDodo: (addr, pool) =>
      resolvedRefreshers.refreshDodo({
        ...buildBaseArgs(),
        addr,
        pool,
      }),
    refreshWoofi: (addr, pool) =>
      resolvedRefreshers.refreshWoofi({
        ...buildBaseArgs(),
        addr,
        pool,
      }),
    refreshV3: (addr, pool, rawLog) =>
      resolvedRefreshers.refreshV3({
        ...buildBaseArgs(),
        addr,
        pool,
        rawLog,
      }),
  };
}
