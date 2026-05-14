/**
 * src/routing/route_cache.js — Top-N profitable route cache
 *
 * Stores the top `maxSize` (default 1 000) profitable arbitrage routes found
 * during previous simulation passes.  On every HyperSync batch the watcher
 * reports which pools changed; the cache returns only the routes that touch
 * those pools so they can be re-validated cheaply without re-running a full
 * cycle enumeration.
 *
 * Lifecycle
 * ─────────
 *   1. After each arb scan, call cache.update(profitable)
 *      where profitable = [{ path, result }] sorted by profit desc.
 *   2. On watcher.onBatch(changedAddrs), call cache.getByPools(changedAddrs)
 *      and re-simulate those paths first (fast, targeted).
 *   3. Periodically call cache.prune(stateCache) to drop routes whose pools
 *      are no longer in the state cache (removed pools).
 *
 * Thread safety: single-threaded (main thread only).
 */

import { routeIdentityFromEdges, type RouteIdentityEdge } from "./route_identity.ts";
import { normalizeEvmAddress } from "../utils/pool_record.ts";

type CachedPath = { startToken: string; edges: RouteIdentityEdge[] };
type CachedResult = { profit: bigint };
type CachedAssessment = {
  netProfitAfterGas?: bigint | null;
  netProfit?: bigint | null;
};
type CachedEntry = {
  key: string;
  pools: string[];
  path: CachedPath;
  result: CachedResult;
  assessment?: CachedAssessment;
  profit: bigint;
};

function normalisePoolAddress(poolAddress: unknown) {
  return normalizeEvmAddress(poolAddress);
}

function hasValidPoolEdges(path: CachedPath | null | undefined) {
  return Array.isArray(path?.edges) && path.edges.every((edge) => normalisePoolAddress(edge?.poolAddress) != null);
}

function normalizedRoutePools(path: CachedPath | null | undefined) {
  if (!Array.isArray(path?.edges)) return null;
  const pools: string[] = [];
  for (const edge of path.edges) {
    const pool = normalisePoolAddress(edge?.poolAddress);
    if (!pool) return null;
    pools.push(pool);
  }
  return pools;
}

function profitFromResult(result: CachedResult | null | undefined) {
  try {
    if (result?.profit == null) return null;
    return typeof result.profit === "bigint" ? result.profit : BigInt(result.profit);
  } catch {
    return null;
  }
}

function profitFromAssessment(assessment: CachedAssessment | null | undefined) {
  try {
    const profit = assessment?.netProfitAfterGas ?? assessment?.netProfit;
    if (profit == null) return null;
    return typeof profit === "bigint" ? profit : BigInt(profit);
  } catch {
    return null;
  }
}

function isCachedEntry(value: CachedEntry | undefined): value is CachedEntry {
  return value != null;
}

export class RouteCache {
  private _maxSize: number;
  private _routes: CachedEntry[];
  private _poolIndex: Map<string, Set<number>>;

  constructor(maxSize = 1_000) {
    this._maxSize = maxSize;
    this._routes = [];
    this._poolIndex = new Map();
  }

  // ─── Mutation ──────────────────────────────────────────────

  /**
   * Update the cache with fresh simulation results.
   *
   * Merges new profitable routes with existing ones, re-ranks by profit, and
   * keeps only the top `maxSize`.  Rebuilds the pool index from scratch.
   *
   * @param {Array<{ path: object, result: object, assessment?: object }>} profitable
   *   Profitable routes from evaluatePaths / evaluatePathsParallel.
   */
  update(profitable: Array<{ path: CachedPath; result: CachedResult; assessment?: CachedAssessment }>) {
    if (!profitable || profitable.length === 0) return;

    // Normalise profit to BigInt (workers deserialise as strings). Prefer
    // execution-grade net profit when callers provide an assessment.
    const toAdd: CachedEntry[] = [];
    for (const { path, result, assessment } of profitable) {
      const pools = normalizedRoutePools(path);
      if (!pools) continue;
      const profit = profitFromAssessment(assessment) ?? profitFromResult(result);
      if (profit == null) continue;
      const key = routeIdentityFromEdges(path.startToken, path.edges);
      const entry: CachedEntry = { key, pools, path, result, profit };
      if (assessment != null) entry.assessment = assessment;
      toAdd.push(entry);
    }
    if (toAdd.length === 0) return;

    // Fast path: skip full rebuild only when no new keys AND profits are unchanged.
    // The cache must remain sorted by profit — in-place mutation without re-sort
    // would violate that invariant and cause downstream consumers to pick stale
    // top-ranked routes.
    const existingKeys = new Set(this._routes.map((e) => e.key));
    const hasNewKeys = toAdd.some((e) => !existingKeys.has(e.key));
    if (!hasNewKeys && this._routes.length <= this._maxSize) {
      let changed = false;
      for (const entry of toAdd) {
        const idx = this._routes.findIndex((e) => e.key === entry.key);
        if (idx >= 0 && this._routes[idx].profit !== entry.profit) {
          changed = true;
        }
        if (idx >= 0) this._routes[idx] = entry;
      }
      if (!changed) return;
      // Re-sort when profits changed to maintain sorted invariant.
      this._routes.sort((a, b) => (b.profit > a.profit ? 1 : b.profit < a.profit ? -1 : 0));
      return;
    }

    // Prefer the latest observation for a route before ranking by profit.
    // Otherwise an older, stale high-profit snapshot can mask a fresh lower-profit update.
    const latestByRouteKey = new Map<string, CachedEntry>();
    for (const entry of this._routes) {
      latestByRouteKey.set(entry.key, entry);
    }
    for (const entry of toAdd) {
      latestByRouteKey.set(entry.key, entry);
    }

    const merged = [...latestByRouteKey.values()];
    merged.sort((a, b) => (b.profit > a.profit ? 1 : b.profit < a.profit ? -1 : 0));

    const newRoutes = merged.slice(0, this._maxSize);
    const newIndex = this._buildIndex(newRoutes);
    this._routes = newRoutes;
    this._poolIndex = newIndex;
  }

  // ─── Query ─────────────────────────────────────────────────

  /**
   * Return cached routes that include at least one of the changed pools.
   *
   * Used by the watcher callback to fast-revalidate affected routes before
   * running a full arb scan.
   *
   * @param {Set<string>|string[]} changedPools  Lowercase pool addresses
   * @returns {Array<{ path: object, result: object }>}
   */
  getByPools(changedPools: Set<string> | string[]) {
    const idxSet = new Set<number>();
    for (const pool of changedPools) {
      const normalizedPool = normalisePoolAddress(pool);
      if (!normalizedPool) continue;
      const hits = this._poolIndex.get(normalizedPool);
      if (hits) for (const i of hits) idxSet.add(i);
    }
    return [...idxSet].map((i) => this._routes[i]).filter(isCachedEntry);
  }

  /**
   * Return all cached routes.
   *
   * @returns {Array<{ path: object, result: object }>}
   */
  getAll() {
    return this._routes;
  }

  /**
   * Number of cached routes.
   * @returns {number}
   */
  get size() {
    return this._routes.length;
  }

  // ─── Maintenance ───────────────────────────────────────────

  /**
   * Remove routes containing pools that are no longer in stateCache.
   * Call after watcher restarts or pool removals.
   *
   * @param {Map<string, object>} stateCache
   */
  prune(stateCache: Map<string, object>) {
    const normalisedStatePools = new Set(
      [...stateCache.keys()]
        .map((poolAddress) => normalisePoolAddress(poolAddress))
        .filter((poolAddress): poolAddress is string => poolAddress != null),
    );
    const before = this._routes.length;
    const newRoutes = this._routes.filter((entry) => entry.pools.every((pool) => normalisedStatePools.has(pool)));
    if (newRoutes.length < before) {
      const newIndex = this._buildIndex(newRoutes);
      this._routes = newRoutes;
      this._poolIndex = newIndex;
    }
  }

  /**
   * Remove cached routes that touch any pool in the provided set.
   *
   * Useful when a watcher batch makes specific pools unroutable while the rest
   * of the cache remains valid.
   *
   * @param {Set<string>|string[]} poolAddresses
   * @returns {number} number of removed routes
   */
  removeByPools(poolAddresses: Set<string> | string[]) {
    const blocked = new Set([...poolAddresses].map((pool) => normalisePoolAddress(pool)).filter((pool): pool is string => pool != null));
    if (blocked.size === 0 || this._routes.length === 0) return 0;

    const blockedIndexes = new Set<number>();
    for (const pool of blocked) {
      const hits = this._poolIndex.get(pool);
      if (hits) for (const index of hits) blockedIndexes.add(index);
    }
    if (blockedIndexes.size === 0) return 0;

    const before = this._routes.length;
    this._routes = this._routes.filter((_, index) => !blockedIndexes.has(index));
    if (this._routes.length < before) this._rebuildIndex();
    return before - this._routes.length;
  }

  /**
   * Remove one exact cached route by its stable route identity.
   *
   * Useful when execution preparation proves a simulated route cannot be built
   * or estimated on-chain. Evicting only the failed route avoids repeatedly
   * re-selecting the same stale cached false-positive while preserving other
   * routes that happen to touch the same active pools.
   *
   * @param {object} path route path containing startToken and edges
   * @returns {number} number of removed routes
   */
  removeByRoute(path: CachedPath | null | undefined) {
    if (!path || !hasValidPoolEdges(path) || this._routes.length === 0) return 0;
    const blockedKey = routeIdentityFromEdges(path.startToken, path.edges);
    const before = this._routes.length;
    this._routes = this._routes.filter((entry) => entry.key !== blockedKey);
    if (this._routes.length < before) this._rebuildIndex();
    return before - this._routes.length;
  }

  /**
   * Clear the cache.
   */
  clear() {
    this._routes = [];
    this._poolIndex.clear();
  }

  get routes() {
    return this._routes;
  }

  // ─── Internal ──────────────────────────────────────────────

  _buildIndex(routes: CachedEntry[]) {
    const index = new Map<string, Set<number>>();
    for (let i = 0; i < routes.length; i++) {
      const entry = routes[i];
      if (!entry) continue;
      for (const pool of entry.pools) {
        if (!index.has(pool)) index.set(pool, new Set());
        index.get(pool)?.add(i);
      }
    }
    return index;
  }

  _rebuildIndex() {
    this._poolIndex = this._buildIndex(this._routes);
  }
}
