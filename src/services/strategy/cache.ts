import { routeKeyFromEdges } from "./finder.ts";
import type { FoundCycle } from "./finder.ts";

export interface CachedResult {
  key: string;
  profit: bigint;
  pools: string[];
  path: FoundCycle;
  timestamp: number;
}

/** Bounded LRU-like cache for route simulation results. */
export class RouteCache {
  private entries = new Map<string, CachedResult>();
  constructor(private maxSize = 1000) {}

  update(results: Array<{ path: FoundCycle; profit: bigint }>): void {
    for (const r of results) {
      const pools = r.path.edges.map((e) => e.poolAddress.toLowerCase());
      const key = routeKeyFromEdges(r.path.edges, r.path.startToken);
      this.entries.set(key, { key, profit: r.profit, pools, path: r.path, timestamp: Date.now() });
    }
    if (this.entries.size > this.maxSize) this.prune();
  }

  /** Get cached results touching any of the given changed pools. */
  getByPools(changedPools: Set<string>): CachedResult[] {
    const results: CachedResult[] = [];
    for (const entry of this.entries.values()) {
      for (const pool of entry.pools) {
        if (changedPools.has(pool)) {
          results.push(entry);
          break;
        }
      }
    }
    return results;
  }

  getAll(): CachedResult[] {
    return Array.from(this.entries.values());
  }

  get size(): number {
    return this.entries.size;
  }

  /** Remove low-profit entries when over capacity. */
  prune(): void {
    const sorted = Array.from(this.entries.values()).sort((a, b) => {
      if (b.profit > a.profit) return 1;
      if (b.profit < a.profit) return -1;
      return 0;
    });
    this.entries.clear();
    for (const entry of sorted.slice(0, this.maxSize)) {
      this.entries.set(entry.key, entry);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
