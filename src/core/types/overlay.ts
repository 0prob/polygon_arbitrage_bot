import type { Address } from "./common.ts";
import type { PoolState } from "./pool.ts";

export interface PendingStateOverlayOptions {
  ttlMs?: number;
  maxPools?: number;
}

export interface PendingStateOverlay {
  update(poolAddress: Address, state: PoolState): void;
  get(poolAddress: Address): PoolState | undefined;
  getProjected(poolAddress: Address, baseState: PoolState): PoolState | undefined;
  clear(): void;
}

export class InMemoryPendingStateOverlay implements PendingStateOverlay {
  private cache = new Map<string, { state: PoolState; timestamp: number }>();
  private ttlMs: number;
  private maxPools: number;

  // Fields where pending swaps contribute additive deltas to the base state.
  private static DELTA_FIELDS = new Set([
    "reserve0",
    "reserve1",
    "balances",
    "baseReserve",
    "quoteReserve",
    "quoteTarget",
    "baseTarget",
    "totalLiquidity",
  ]);

  constructor(opts?: PendingStateOverlayOptions) {
    this.ttlMs = opts?.ttlMs ?? 1000;
    this.maxPools = opts?.maxPools ?? 500;
  }

  private isExpired(timestamp: number): boolean {
    return Date.now() - timestamp > this.ttlMs;
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now - entry.timestamp > this.ttlMs) this.cache.delete(key);
    }
  }

  private touch(key: string, state: PoolState, now: number): void {
    if (this.cache.has(key)) this.cache.delete(key);
    this.cache.set(key, { state, timestamp: now });
    while (this.cache.size > this.maxPools) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  update(poolAddress: Address, state: PoolState): void {
    const key = poolAddress.toLowerCase();
    const now = Date.now();
    this.pruneExpired();
    const existing = this.cache.get(key);

    if (existing && !this.isExpired(existing.timestamp)) {
      const merged: PoolState = { ...existing.state };
      for (const [k, v] of Object.entries(state)) {
        if (InMemoryPendingStateOverlay.DELTA_FIELDS.has(k)) {
          if (k === "balances" && Array.isArray(v) && Array.isArray(merged[k])) {
            const mBal = merged[k] as bigint[];
            const vBal = v as bigint[];
            merged[k] = mBal.map((b, i) => b + (vBal[i] ?? 0n));
          } else {
            const val = v as bigint;
            const current = merged[k] as bigint | undefined;
            merged[k] = current !== undefined ? current + val : val;
          }
        } else {
          merged[k] = v;
        }
      }
      this.touch(key, merged, now);
    } else {
      this.touch(key, state, now);
    }
  }

  get(poolAddress: Address): PoolState | undefined {
    const key = poolAddress.toLowerCase();
    const entry = this.cache.get(key);
    if (!entry || this.isExpired(entry.timestamp)) {
      if (entry) this.cache.delete(key);
      return undefined;
    }
    return entry.state;
  }

  getProjected(poolAddress: Address, baseState: PoolState): PoolState | undefined {
    const key = poolAddress.toLowerCase();
    const entry = this.cache.get(key);
    if (!entry || this.isExpired(entry.timestamp)) {
      if (entry) this.cache.delete(key);
      return undefined;
    }

    const projected: PoolState = { ...baseState };
    for (const [field, value] of Object.entries(entry.state)) {
      if (InMemoryPendingStateOverlay.DELTA_FIELDS.has(field)) {
        if (field === "balances" && Array.isArray(value) && Array.isArray(baseState[field])) {
          const bBal = baseState[field] as bigint[];
          const vBal = value as bigint[];
          projected[field] = bBal.map((b, i) => b + (vBal[i] ?? 0n));
        } else {
          const base = baseState[field] as bigint | undefined;
          projected[field] = base !== undefined ? base + (value as bigint) : (value as bigint);
        }
      } else {
        projected[field] = value;
      }
    }
    return projected;
  }

  clear(): void {
    this.cache.clear();
  }
}
