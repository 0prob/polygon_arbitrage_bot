import type { Address } from "./common.ts";
import type { PoolState } from "./pool.ts";

export interface PendingStateOverlay {
  update(poolAddress: Address, state: PoolState): void;
  get(poolAddress: Address): PoolState | undefined;
  getProjected(poolAddress: Address, baseState: PoolState): PoolState | undefined;
  clear(): void;
}

export class InMemoryPendingStateOverlay implements PendingStateOverlay {
  private cache = new Map<string, { state: PoolState; timestamp: number }>();
  private TTL = 1000; // ms - raised to 1s to better bridge the block interval

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

  update(poolAddress: Address, state: PoolState): void {
    const key = poolAddress.toLowerCase();
    const now = Date.now();
    const existing = this.cache.get(key);

    if (existing && now - existing.timestamp <= this.TTL) {
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
          // Absolute fields (sqrtPriceX96, tick, etc.) are replaced by the latest pending tx value.
          // This is still an approximation as we don't know the order of pending txs perfectly,
          // but better than adding them.
          merged[k] = v;
        }
      }
      this.cache.set(key, { state: merged, timestamp: now });
    } else {
      this.cache.set(key, { state, timestamp: now });
    }
  }

  get(poolAddress: Address): PoolState | undefined {
    const key = poolAddress.toLowerCase();
    const entry = this.cache.get(key);
    if (!entry || Date.now() - entry.timestamp > this.TTL) {
      return undefined;
    }
    return entry.state;
  }

  getProjected(poolAddress: Address, baseState: PoolState): PoolState | undefined {
    const entry = this.cache.get(poolAddress.toLowerCase());
    if (!entry || Date.now() - entry.timestamp > this.TTL) return undefined;

    const projected: PoolState = { ...baseState };
    for (const [key, value] of Object.entries(entry.state)) {
      if (InMemoryPendingStateOverlay.DELTA_FIELDS.has(key)) {
        if (key === "balances" && Array.isArray(value) && Array.isArray(baseState[key])) {
          const bBal = baseState[key] as bigint[];
          const vBal = value as bigint[];
          projected[key] = bBal.map((b, i) => b + (vBal[i] ?? 0n));
        } else {
          const base = baseState[key] as bigint | undefined;
          projected[key] = base !== undefined ? base + (value as bigint) : (value as bigint);
        }
      } else {
        // Replace base field with pending absolute value
        projected[key] = value;
      }
    }
    return projected;
  }

  clear(): void {
    this.cache.clear();
  }
}
