import type { FoundCycle } from "../pipeline/index.ts";
import type { PoolMeta } from "../core/types/pool.ts";

export interface PassLoopState {
  cachedCycles: FoundCycle[];
  hasuraPoolsCache: PoolMeta[] | null;
  cachedMetas: Map<string, { decimals: number }> | null;
  cachedRates: Map<string, bigint> | null;
  tokenToMaticRates: Map<string, bigint>;
  ratesNeedFullRefresh: boolean;
  pendingFocusTokens: Set<string> | null;
  lastRefreshTime: number;
  lastReorgCheck: number;
  lastStatusWriteTime: number;
  lastMempoolTraceId: string | undefined;
  lfEnumerationInFlight: boolean;
  cycleWindowStart: number;
  recentRouteTimestamps: Map<string, number>;
  headTriggered: boolean;
  lastHeadTime: number;
  lastTierCheck: number;
  lfTickInFlight: boolean;
  maticPriceUsd: number;
}
