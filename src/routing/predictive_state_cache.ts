import type { RouteCache } from "./route_cache.ts";
import type { ArbPathLike, AssessmentLike } from "../arb/assessment.ts";
import { assessRouteResult } from "../arb/assessment.ts";
import { simulateRouteUncached } from "./simulator.ts";
import type { RouteStateCache } from "./simulation_types.ts";
import { logger } from "../utils/logger.ts";
import { recordPredictiveCacheTelemetry } from "../utils/metrics.ts";

export type PredictivePathEntry = {
  path: ArbPathLike;
  lastProfit: bigint;
  cachedAmountIn: bigint;
  cachedAmountOut: bigint;
  cachedTotalGas: number;
  lastAssessment: AssessmentLike | null;
  lastUpdateTime: number;
  affectedTokens: Set<string>;
  affectedPools: Set<string>;
  isStale: boolean;
  stalenessReason?: "pool_state_change" | "token_balance_change" | "gas_change" | "manual";
};

export type PredictiveStateCacheOptions = {
  maxTrackedPaths: number;
  stalenessThresholdMs: number;
  precomputeTopN: number;
  testAmountWei?: bigint;
  minProfitWei?: bigint;
  flashLoanFeeBps?: bigint;
};

const DEFAULT_OPTIONS: PredictiveStateCacheOptions = {
  maxTrackedPaths: 500,
  stalenessThresholdMs: 5000,
  precomputeTopN: 50,
  flashLoanFeeBps: 0n,
};

export class PredictiveStateCache {
  private _routeCache: RouteCache;
  private _options: PredictiveStateCacheOptions;
  private _shadowState: Map<string, PredictivePathEntry>;
  private _tokenToPaths: Map<string, Set<string>>;
  private _poolToPaths: Map<string, Set<string>>;
  private _stateCache: RouteStateCache | null = null;
  private _getGasPriceWei: (() => bigint) | null = null;
  private _getTokenToMaticRate: ((token: string) => bigint) | null = null;
  private _lastUpdateTime: number = Date.now();
  private _roundRobinCursor = 0;

  private _stats = {
    precomputationCycles: 0,
    pathsUpdated: 0,
    pathsStale: 0,
    hitRate: 0,
    lastUpdateTime: Date.now(),
  };

  constructor(routeCache: RouteCache, options: Partial<PredictiveStateCacheOptions> = {}) {
    this._routeCache = routeCache;
    this._options = { ...DEFAULT_OPTIONS, ...options };
    this._shadowState = new Map();
    this._tokenToPaths = new Map();
    this._poolToPaths = new Map();
  }

  setStateCache(stateCache: RouteStateCache): void {
    this._stateCache = stateCache;
  }

  setGasPriceProvider(getGasPriceWei: () => bigint): void {
    this._getGasPriceWei = getGasPriceWei;
  }

  setTokenRateProvider(getTokenToMaticRate: (token: string) => bigint): void {
    this._getTokenToMaticRate = getTokenToMaticRate;
  }

  populateShadowState(options: { maxPaths?: number; testAmount?: bigint } = {}): void {
    const maxPaths = options.maxPaths ?? this._options.precomputeTopN;
    const testAmount = options.testAmount ?? BigInt("1000000000000000000");
    const cachedRoutes = this._routeCache.getAll();
    const routesToTrack = cachedRoutes.slice(0, maxPaths);

    logger.info({ cachedCount: cachedRoutes.length, trackingCount: routesToTrack.length }, "[predictive-cache] Populating shadow state");

    for (const route of routesToTrack) {
      try {
        const entry = this._createPathEntry(route.path, route.result, testAmount);
        if (entry) {
          this._addToShadowState(entry);
        }
      } catch (error) {
        logger.debug({ error }, "[predictive-cache] Failed to track path");
      }
    }

    recordPredictiveCacheTelemetry({
      trackedPaths: this._shadowState.size,
      hitRate: 0,
      staleness: this._getStaleCount(),
    });
  }

  notifyPoolStateChanged(poolAddresses: Set<string>): number {
    let staleCount = 0;
    for (const pool of poolAddresses) {
      const normalized = pool.toLowerCase();
      const pathKeys = this._poolToPaths.get(normalized);
      if (!pathKeys) continue;
      for (const key of pathKeys) {
        const entry = this._shadowState.get(key);
        if (entry && !entry.isStale) {
          entry.isStale = true;
          entry.stalenessReason = "pool_state_change";
          staleCount++;
        }
      }
    }
    this._stats.pathsStale += staleCount;
    return staleCount;
  }

  updateAffectedPaths(changedPools: Set<string>, testAmount: bigint = BigInt("1000000000000000000")): number {
    const affectedPathKeys = new Set<string>();
    for (const pool of changedPools) {
      const pathKeys = this._poolToPaths.get(pool.toLowerCase());
      if (pathKeys) {
        for (const key of pathKeys) {
          affectedPathKeys.add(key);
        }
      }
    }

    if (affectedPathKeys.size === 0) return 0;

    logger.debug({ poolCount: changedPools.size, pathCount: affectedPathKeys.size }, "[predictive-cache] Re-simulating affected paths");

    let updatedCount = 0;
    for (const pathKey of affectedPathKeys) {
      const entry = this._shadowState.get(pathKey);
      if (!entry) continue;
      const success = this._reSimulatePath(entry.path, testAmount);
      if (success) updatedCount++;
    }

    this._stats.pathsUpdated += updatedCount;
    return updatedCount;
  }

  getBestPath(): PredictivePathEntry | null {
    let best: PredictivePathEntry | null = null;
    let bestProfit = BigInt(0);
    for (const entry of this._shadowState.values()) {
      if (entry.lastProfit > bestProfit && !entry.isStale) {
        bestProfit = entry.lastProfit;
        best = entry;
      }
    }
    return best;
  }

  getAllPaths(sortByProfit = true): PredictivePathEntry[] {
    const paths = Array.from(this._shadowState.values());
    if (sortByProfit) {
      paths.sort((a, b) => (b.lastProfit > a.lastProfit ? 1 : b.lastProfit < a.lastProfit ? -1 : 0));
    }
    return paths;
  }

  get size(): number {
    return this._shadowState.size;
  }

  getStats() {
    const staleAfterAge = this._getStaleAfterAgeCount();
    return {
      ...this._stats,
      trackedPaths: this._shadowState.size,
      stalePaths: this._getStaleCount(),
      staleAfterAge,
      roundRobinCursor: this._roundRobinCursor,
    };
  }

  /**
   * Pre-compute a batch of fresh paths during idle time.
   * Uses round-robin to spread work across cycles.
   * Call this after the arb scan completes, during the idle window before the next block.
   */
  prefetchBatch(batchSize = 5, testAmount?: bigint): number {
    const amount = testAmount ?? this._options.testAmountWei ?? BigInt("1000000000000000000");
    this._syncFromRouteCache(batchSize, amount);
    const entries = Array.from(this._shadowState.entries());
    if (entries.length === 0) return 0;

    let updatedCount = 0;
    for (let i = 0; i < batchSize; i++) {
      const idx = (this._roundRobinCursor + i) % entries.length;
      const entry = entries[idx][1];

      if (entry.isStale) {
        const success = this._reSimulatePath(entry.path, amount);
        if (success) updatedCount++;
      } else {
        const age = Date.now() - entry.lastUpdateTime;
        if (age > this._options.stalenessThresholdMs) {
          const success = this._reSimulatePath(entry.path, amount);
          if (success) updatedCount++;
        }
      }
    }

    this._roundRobinCursor = (this._roundRobinCursor + batchSize) % entries.length;
    this._stats.precomputationCycles++;
    if (updatedCount > 0) {
      this._stats.pathsUpdated += updatedCount;
    }

    return updatedCount;
  }

  private _syncFromRouteCache(batchSize: number, testAmount: bigint): void {
    const cachedRoutes = this._routeCache.getAll();
    let added = 0;
    for (const route of cachedRoutes) {
      if (added >= batchSize) break;
      const pathKey = this._getPathKey(route.path);
      if (!this._shadowState.has(pathKey)) {
        try {
          const entry = this._createPathEntry(route.path, route.result, testAmount);
          if (entry) {
            this._addToShadowState(entry);
            added++;
          }
        } catch {
          continue;
        }
      }
    }
    if (added > 0) {
      this._stats.pathsUpdated += added;
      logger.debug({ added, totalTracked: this._shadowState.size }, "[predictive-cache] Synced new routes from route cache");
    }
  }

  private _getStaleAfterAgeCount(): number {
    const now = Date.now();
    let count = 0;
    for (const entry of this._shadowState.values()) {
      if (!entry.isStale && now - entry.lastUpdateTime > this._options.stalenessThresholdMs) {
        count++;
      }
    }
    return count;
  }

  private _createPathEntry(path: any, cachedResult: any, testAmount: bigint): PredictivePathEntry | null {
    const affectedTokens = new Set<string>();
    const affectedPools = new Set<string>();
    if (path.edges) {
      for (const edge of path.edges) {
        if (edge.tokenIn) affectedTokens.add(edge.tokenIn.toLowerCase());
        if (edge.tokenOut) affectedTokens.add(edge.tokenOut.toLowerCase());
        if (edge.poolAddress) affectedPools.add(edge.poolAddress.toLowerCase());
      }
    }
    if (path.startToken) {
      affectedTokens.add(path.startToken.toLowerCase());
    }

    const simulation = this._simulatePath(path, testAmount);
    if (!simulation) return null;

    return {
      path,
      lastProfit: simulation.profit,
      cachedAmountIn: simulation.amountIn,
      cachedAmountOut: simulation.amountOut,
      cachedTotalGas: simulation.totalGas,
      lastAssessment: simulation.assessment,
      lastUpdateTime: Date.now(),
      affectedTokens,
      affectedPools,
      isStale: false,
    };
  }

  private _addToShadowState(entry: PredictivePathEntry): void {
    const pathKey = this._getPathKey(entry.path);
    const oldEntry = this._shadowState.get(pathKey);
    if (oldEntry) this._removeFromIndexes(oldEntry);
    this._shadowState.set(pathKey, entry);
    this._addToIndexes(entry);
    if (this._shadowState.size > this._options.maxTrackedPaths) {
      this._evictLeastProfitable();
    }
  }

  private _addToIndexes(entry: PredictivePathEntry): void {
    const pathKey = this._getPathKey(entry.path);
    for (const token of entry.affectedTokens) {
      if (!this._tokenToPaths.has(token)) this._tokenToPaths.set(token, new Set());
      this._tokenToPaths.get(token)!.add(pathKey);
    }
    for (const pool of entry.affectedPools) {
      if (!this._poolToPaths.has(pool)) this._poolToPaths.set(pool, new Set());
      this._poolToPaths.get(pool)!.add(pathKey);
    }
  }

  private _removeFromIndexes(entry: PredictivePathEntry): void {
    const pathKey = this._getPathKey(entry.path);
    for (const token of entry.affectedTokens) {
      const tokenSet = this._tokenToPaths.get(token);
      if (tokenSet) tokenSet.delete(pathKey);
    }
    for (const pool of entry.affectedPools) {
      const poolSet = this._poolToPaths.get(pool);
      if (poolSet) poolSet.delete(pathKey);
    }
  }

  private _getPathKey(path: { startToken: string; edges: Array<{ poolAddress?: string }> }): string {
    const edges = path.edges || [];
    const poolIds = edges
      .map((e: any) => e.poolAddress?.toLowerCase() || "")
      .filter(Boolean)
      .join(",");
    return `${path.startToken || ""}->${poolIds}`;
  }

  private _simulatePath(
    path: any,
    testAmount: bigint,
  ): { profit: bigint; amountIn: bigint; amountOut: bigint; totalGas: number; assessment: AssessmentLike | null } | null {
    try {
      if (!this._stateCache) {
        logger.debug("[predictive-cache] stateCache not set, skipping simulation");
        return null;
      }

      const result = simulateRouteUncached(path, testAmount, this._stateCache);
      if (!result || typeof result.profit !== "bigint") return null;

      let assessment: AssessmentLike | null = null;
      const gasPriceWei = this._getGasPriceWei?.() ?? 0n;
      const tokenToMaticRate = this._getTokenToMaticRate?.(path.startToken) ?? 0n;

      if (gasPriceWei > 0n && tokenToMaticRate > 0n) {
        assessment = assessRouteResult(path, result, gasPriceWei, tokenToMaticRate, {
          minProfitWei: this._options.minProfitWei ?? BigInt("100000000000000"),
          flashLoanFeeBps: this._options.flashLoanFeeBps ?? 0n,
        });
      }

      return { profit: result.profit, amountIn: result.amountIn, amountOut: result.amountOut, totalGas: result.totalGas, assessment };
    } catch (error) {
      logger.debug({ error }, "[predictive-cache] Simulation failed");
      return null;
    }
  }

  private _reSimulatePath(path: ArbPathLike, testAmount: bigint): boolean {
    const pathKey = this._getPathKey(path);
    const entry = this._shadowState.get(pathKey);
    if (!entry) return false;

    const result = this._simulatePath(path, testAmount);
    if (!result) return false;

    entry.lastProfit = result.profit;
    entry.cachedAmountIn = result.amountIn;
    entry.cachedAmountOut = result.amountOut;
    entry.cachedTotalGas = result.totalGas;
    entry.lastAssessment = result.assessment;
    entry.lastUpdateTime = Date.now();
    entry.isStale = false;
    entry.stalenessReason = undefined;
    return true;
  }

  private _getStaleCount(): number {
    let count = 0;
    for (const entry of this._shadowState.values()) {
      if (entry.isStale) count++;
    }
    return count;
  }

  private _evictLeastProfitable(): void {
    let minProfit = BigInt(Number.MAX_SAFE_INTEGER);
    let minKey: string | null = null;
    for (const [key, entry] of this._shadowState.entries()) {
      if (entry.lastProfit < minProfit) {
        minProfit = entry.lastProfit;
        minKey = key;
      }
    }
    if (minKey) {
      const entry = this._shadowState.get(minKey);
      if (entry) {
        this._removeFromIndexes(entry);
        this._shadowState.delete(minKey);
      }
    }
  }
}
