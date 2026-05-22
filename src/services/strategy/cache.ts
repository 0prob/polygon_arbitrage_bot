import { routeKeyFromEdges } from "./finder.ts";
import type { FoundCycle } from "./finder.ts";

export interface CachedResult {
  key: string;
  profit: bigint;
  pools: string[];
  path: FoundCycle;
  timestamp: number;
  accessCount: number;
}

export interface CacheStats {
  size: number;
  maxSize: number;
  totalHits: number;
  totalMisses: number;
  hitRate: number;
  oldestEntryMs: number;
  newestEntryMs: number;
}

export class RouteCache {
  private entries = new Map<string, CachedResult>();
  private totalHits = 0;
  private totalMisses = 0;

  constructor(
    private maxSize = 1000,
    private ttlMs = 30_000,
  ) {}

  update(results: Array<{ path: FoundCycle; profit: bigint }>): void {
    const now = Date.now();
    for (const r of results) {
      const pools = r.path.edges.map((e) => e.poolAddress.toLowerCase());
      const key = routeKeyFromEdges(r.path.edges, r.path.startToken);
      const existing = this.entries.get(key);
      if (existing) {
        existing.profit = r.profit;
        existing.pools = pools;
        existing.path = r.path;
        existing.timestamp = now;
      } else {
        this.entries.set(key, { key, profit: r.profit, pools, path: r.path, timestamp: now, accessCount: 0 });
      }
    }
    const cutoff = now - this.ttlMs;
    for (const [key, entry] of this.entries) {
      if (entry.timestamp < cutoff) {
        this.entries.delete(key);
      }
    }
    if (this.entries.size > this.maxSize) this.prune();
  }

  getByPools(changedPools: Set<string>): CachedResult[] {
    const now = Date.now();
    const results: CachedResult[] = [];
    for (const entry of this.entries.values()) {
      if (now - entry.timestamp > this.ttlMs) continue;
      for (const pool of entry.pools) {
        if (changedPools.has(pool)) {
          entry.accessCount++;
          this.totalHits++;
          results.push(entry);
          break;
        }
      }
    }
    if (results.length === 0) {
      this.totalMisses++;
    }
    return results;
  }

  getAll(): CachedResult[] {
    return Array.from(this.entries.values());
  }

  get size(): number {
    return this.entries.size;
  }

  private entrySortKey(entry: CachedResult, now: number): bigint {
    return entry.profit * 1_000_000_000n + BigInt(entry.accessCount) * 1_000_000n - BigInt(now - entry.timestamp);
  }

  prune(): void {
    const now = Date.now();
    const sorted = Array.from(this.entries.values()).sort((a, b) => {
      const ka = this.entrySortKey(a, now);
      const kb = this.entrySortKey(b, now);
      if (kb > ka) return 1;
      if (kb < ka) return -1;
      return 0;
    });
    this.entries.clear();
    for (let i = 0; i < this.maxSize && i < sorted.length; i++) {
      this.entries.set(sorted[i].key, sorted[i]);
    }
  }

  clear(): void {
    this.entries.clear();
    this.totalHits = 0;
    this.totalMisses = 0;
  }

  getStats(): CacheStats {
    const now = Date.now();
    let oldestMs = now;
    let newestMs = 0;
    for (const entry of this.entries.values()) {
      if (entry.timestamp < oldestMs) oldestMs = entry.timestamp;
      if (entry.timestamp > newestMs) newestMs = entry.timestamp;
    }
    const total = this.totalHits + this.totalMisses;
    return {
      size: this.entries.size,
      maxSize: this.maxSize,
      totalHits: this.totalHits,
      totalMisses: this.totalMisses,
      hitRate: total > 0 ? this.totalHits / total : 0,
      oldestEntryMs: oldestMs,
      newestEntryMs: newestMs,
    };
  }
}
