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
}
