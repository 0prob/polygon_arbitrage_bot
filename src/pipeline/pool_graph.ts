import type { PoolMeta } from "../core/types/pool.ts";
import type { RouteStateCache } from "../core/types/route.ts";
import { normalizeAddress, normalizePoolAddress } from "../core/utils/normalize.ts";

export interface PoolGraphEntry {
  meta: PoolMeta;
  state: Record<string, unknown> | null;
}

/**
 * In-RAM pool index for O(1) cross-pool lookups during HF simulation.
 *
 * HyperIndex/Hasura owns discovery metadata; hot reserves/slot0 live in RouteStateCache
 * (RPC multicall). This graph joins both without polling GraphQL per tick.
 */
export class InMemoryPoolGraph {
  private pools = new Map<string, PoolGraphEntry>();
  private byToken = new Map<string, Set<string>>();

  get size(): number {
    return this.pools.size;
  }

  getPool(address: string): PoolGraphEntry | undefined {
    return this.pools.get(normalizePoolAddress(address));
  }

  getState(address: string): Record<string, unknown> | null {
    return this.pools.get(normalizePoolAddress(address))?.state ?? null;
  }

  /** All pools that list this token (any hop position). */
  getPoolsForToken(token: string): PoolGraphEntry[] {
    const addrs = this.byToken.get(normalizeAddress(token));
    if (!addrs || addrs.size === 0) return [];
    const out: PoolGraphEntry[] = [];
    for (const addr of addrs) {
      const entry = this.pools.get(addr);
      if (entry) out.push(entry);
    }
    return out;
  }

  /** Pools that trade directly between tokenA and tokenB (either direction). */
  findDirectPools(tokenA: string, tokenB: string): PoolGraphEntry[] {
    const a = normalizeAddress(tokenA);
    const b = normalizeAddress(tokenB);
    const candidates = this.getPoolsForToken(a);
    return candidates.filter((entry) => {
      const tokens = (entry.meta.tokens ?? [entry.meta.token0, entry.meta.token1]).map(normalizeAddress);
      return tokens.includes(b);
    });
  }

  syncPool(meta: PoolMeta, state: Record<string, unknown> | null): void {
    const addr = normalizePoolAddress(meta.address);
    const prev = this.pools.get(addr);
    if (prev) {
      this.unindexTokens(addr, prev.meta);
    }
    this.pools.set(addr, { meta, state });
    this.indexTokens(addr, meta);
  }

  updateState(poolAddress: string, state: Record<string, unknown> | null): void {
    const addr = normalizePoolAddress(poolAddress);
    const entry = this.pools.get(addr);
    if (entry) {
      entry.state = state;
    }
  }

  /** Full rebuild from discovery list + live RPC cache. */
  bulkSync(pools: readonly PoolMeta[], stateCache: RouteStateCache): number {
    let synced = 0;
    for (const meta of pools) {
      const addr = normalizePoolAddress(meta.address);
      const state = (stateCache.get(addr) as Record<string, unknown> | undefined) ?? null;
      this.syncPool(meta, state);
      synced++;
    }
    return synced;
  }

  /** Patch states after fetchMissingPoolState without rebuilding token index. */
  patchStatesFromCache(stateCache: RouteStateCache, addresses?: Iterable<string>): number {
    let patched = 0;
    const targets = addresses ?? this.pools.keys();
    for (const raw of targets) {
      const addr = normalizePoolAddress(raw);
      const entry = this.pools.get(addr);
      if (!entry) continue;
      const state = stateCache.get(addr) as Record<string, unknown> | undefined;
      if (state) {
        entry.state = state;
        patched++;
      }
    }
    return patched;
  }

  /** Null out cached states after reorg invalidation (meta index is preserved). */
  clearStates(): void {
    for (const entry of this.pools.values()) {
      entry.state = null;
    }
  }

  clear(): void {
    this.pools.clear();
    this.byToken.clear();
  }

  private indexTokens(addr: string, meta: PoolMeta): void {
    const tokens = meta.tokens?.length ? meta.tokens : [meta.token0, meta.token1];
    for (const t of tokens) {
      if (!t) continue;
      const tl = normalizeAddress(t);
      let set = this.byToken.get(tl);
      if (!set) {
        set = new Set();
        this.byToken.set(tl, set);
      }
      set.add(addr);
    }
  }

  private unindexTokens(addr: string, meta: PoolMeta): void {
    const tokens = meta.tokens?.length ? meta.tokens : [meta.token0, meta.token1];
    for (const t of tokens) {
      if (!t) continue;
      const tl = normalizeAddress(t);
      const set = this.byToken.get(tl);
      if (!set) continue;
      set.delete(addr);
      if (set.size === 0) this.byToken.delete(tl);
    }
  }
}
