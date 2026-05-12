
import { PredictiveStateCache, type PredictivePathEntry } from "./predictive_state_cache.ts";
import { RouteCache } from "./route_cache.ts";
import type { ArbPathLike } from "../arb/assessment.ts";
import type { AssessmentLike } from "../arb/assessment.ts";
import type { RouteResultLike } from "./score_route.ts";
import { logger } from "../utils/logger.ts";

export type AffectedRoute = {
  path: ArbPathLike;
  result: RouteResultLike;
};

export type PredictiveCacheAdapterDeps = {
  routeCache: RouteCache;
  testAmountWei: bigint;
  maxTrackedPaths?: number;
  precomputeTopN?: number;
  stalenessThresholdMs?: number;
  usePredictiveCache: boolean;
};

export class PredictiveCacheAdapter {
  private _predictiveCache: PredictiveStateCache | null;
  private _deps: PredictiveCacheAdapterDeps;
  private _isInitialized: boolean;

  constructor(deps: PredictiveCacheAdapterDeps) {
    this._deps = deps;
    this._isInitialized = false;

    if (deps.usePredictiveCache) {
      this._predictiveCache = new PredictiveStateCache(deps.routeCache, {
        maxTrackedPaths: deps.maxTrackedPaths ?? 500,
        precomputeTopN: deps.precomputeTopN ?? 50,
        stalenessThresholdMs: deps.stalenessThresholdMs ?? 5000,
        testAmountWei: deps.testAmountWei,
      });
    } else {
      this._predictiveCache = null;
    }
  }

  setStateCache(stateCache: any): void {
    this._predictiveCache?.setStateCache(stateCache);
  }

  setGasPriceProvider(provider: () => bigint): void {
    this._predictiveCache?.setGasPriceProvider(provider);
  }

  setTokenRateProvider(provider: (token: string) => bigint): void {
    this._predictiveCache?.setTokenRateProvider(provider);
  }

  initialize(): void {
    if (!this._predictiveCache || this._isInitialized) return;

    try {
      this._predictiveCache.populateShadowState({
        maxPaths: this._deps.precomputeTopN ?? 50,
        testAmount: this._deps.testAmountWei,
      });
      this._isInitialized = true;
      logger.info("[predictive-cache] Initialized successfully");
    } catch (error) {
      logger.error({ error }, "[predictive-cache] Initialization failed");
      this._predictiveCache = null;
    }
  }

  async shutdown(): Promise<void> {
    this._predictiveCache = null;
    this._isInitialized = false;
    logger.info("[predictive-cache] Shutdown complete");
  }

  /**
   * Notify the predictive cache that specific pool states changed.
   * Marks affected shadow paths as stale for lazy re-computation.
   */
  notifyPoolStateChanged(poolAddresses: Set<string>): void {
    if (!this._predictiveCache || !this._isInitialized) return;
    const staleCount = this._predictiveCache.notifyPoolStateChanged(poolAddresses);
    if (staleCount > 0) {
      logger.debug(
        { poolCount: poolAddresses.size, stalePaths: staleCount },
        "[predictive-cache] Marked paths stale from pool changes"
      );
    }
  }

  /**
   * Return pre-computed results for affected routes.
   * Only returns entries that are already fresh (non-stale) — no re-simulation here.
   * The revalidation pipeline will re-simulate stale entries on its own.
   * Value comes from idle-time prefetchBatch keeping shadow entries fresh.
   */
  getAffectedRoutes(changedPools: Set<string>): AffectedRoute[] {
    if (!this._predictiveCache || !this._isInitialized) return [];

    try {
      const allPaths = this._predictiveCache.getAllPaths(true);
      const affected: AffectedRoute[] = [];
      const normalizedChanged = new Set(
        Array.from(changedPools, (p) => p.toLowerCase())
      );

      for (const entry of allPaths) {
        if (entry.isStale) continue;
        const touchesChanged = Array.from(entry.affectedPools).some((pool) =>
          normalizedChanged.has(pool)
        );
        if (touchesChanged) {
          affected.push({
            path: entry.path,
            result: this._convertToRouteResult(entry),
          });
        }
      }

      return affected;
    } catch (error) {
      logger.error({ error }, "[predictive-cache] Failed to get affected routes");
      return [];
    }
  }

  /**
   * Prefetch a batch of stale or aging shadow state entries during idle time.
   * Returns the number of paths refreshed.
   */
  async prefetchBatch(batchSize = 5): Promise<number> {
    if (!this._predictiveCache || !this._isInitialized) return 0;
    return this._predictiveCache.prefetchBatch(batchSize, this._deps.testAmountWei);
  }

  getBestPath(): ArbPathLike | null {
    if (!this._predictiveCache || !this._isInitialized) return null;
    const best = this._predictiveCache.getBestPath();
    if (!best || best.lastProfit <= BigInt(0)) return null;
    return best.path;
  }

  isEnabled(): boolean {
    return this._predictiveCache != null && this._isInitialized;
  }

  getStats() {
    if (!this._predictiveCache) return null;
    const stats = this._predictiveCache.getStats();
    return {
      enabled: true,
      initialized: this._isInitialized,
      trackedPaths: stats.trackedPaths,
      precomputationCycles: stats.precomputationCycles,
      stalePaths: stats.stalePaths,
    };
  }

  private _convertToRouteResult(entry: PredictivePathEntry): RouteResultLike {
    const grossProfit = entry.cachedAmountOut - entry.cachedAmountIn;
    return {
      amountIn: entry.cachedAmountIn,
      amountOut: entry.cachedAmountOut,
      profit: grossProfit >= 0n ? grossProfit : 0n,
      totalGas: entry.cachedTotalGas,
      profitable: grossProfit > 0n,
    };
  }
}

export function createPredictiveCacheAdapter(
  deps: PredictiveCacheAdapterDeps
): PredictiveCacheAdapter {
  const adapter = new PredictiveCacheAdapter(deps);
  adapter.initialize();
  return adapter;
}
