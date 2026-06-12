import type { FoundCycle } from "../pipeline/index.ts";
import type { PoolMeta } from "../core/types/pool.ts";
import type { HfReadSnapshot } from "./hf_snapshot.ts";
import type { LargeSwapSignal } from "../services/mempool/signals.ts";

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
  /** Wall time when background cycle enumeration last finished. */
  lastEnumerationTime: number;
  /** Fingerprint from {@link fingerprintPools} — skip re-enumeration when unchanged and within min interval. */
  lastPoolsFingerprint: string;
  cycleWindowStart: number;
  recentRouteTimestamps: Map<string, number>;
  headTriggered: boolean;
  lastHeadTime: number;
  lastTierCheck: number;
  lfTickInFlight: boolean;
  maticPriceUsd: number;
  /** Monotonic counter bumped on each HF snapshot publish. */
  cyclesGeneration: number;
  /** Point-in-time view for HF ticks (see publishHfSnapshot). */
  hfSnapshot: HfReadSnapshot | null;
  /** Most recent large-swap mempool signal (for MEV backrun path). */
  lastLargeSwapSignal?: LargeSwapSignal;
  /** Round-robin offset for HF simulation batch (covers full cycle set over time). */
  hfSimOffset: number;
  /** stateCache.size at last successful enumeration — triggers re-enum when bootstrap fills cache. */
  lastEnumStateCacheSize: number;
  /** Debug: HF tick counter for sampled instrumentation. */
  hfTickCount?: number;
  /** Last HF simulation wall time — drives adaptive sim cap when over budget. */
  lastHfSimMs?: number;
  /** Cached oracle fallback rates (0n = no feed found) — avoids re-querying every HF tick. */
  oracleRateCache?: Map<string, bigint>;
}
