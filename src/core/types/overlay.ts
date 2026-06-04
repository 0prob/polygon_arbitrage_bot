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
  private TTL = 200; // ms

  update(poolAddress: Address, state: PoolState): void {
    this.cache.set(poolAddress.toLowerCase(), { state, timestamp: Date.now() });
  }

  get(poolAddress: Address): PoolState | undefined {
    const entry = this.cache.get(poolAddress.toLowerCase());
    if (!entry || Date.now() - entry.timestamp > this.TTL) return undefined;
    return entry.state;
  }

  getProjected(poolAddress: Address, baseState: PoolState): PoolState | undefined {
    const entry = this.cache.get(poolAddress.toLowerCase());
    if (!entry || Date.now() - entry.timestamp > this.TTL) return undefined;
    const projected: PoolState = { ...baseState };
    for (const [key, value] of Object.entries(entry.state)) {
      const base = baseState[key] as bigint | undefined;
      projected[key] = base !== undefined ? base + (value as bigint) : (value as bigint);
    }
    return projected;
  }

  clear(): void {
    this.cache.clear();
  }
}
