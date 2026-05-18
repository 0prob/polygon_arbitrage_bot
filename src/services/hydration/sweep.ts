import type { PoolMeta } from "../../core/types/pool.ts";
import type { Address } from "../../core/types/common.ts";

export interface SweepOptions {
  batchSize: number;
  intervalMs: number;
  maxRetries: number;
}

export const DEFAULT_SWEEP_OPTIONS: SweepOptions = {
  batchSize: 20,
  intervalMs: 60_000,
  maxRetries: 3,
};

export type PoolStateFetcher = (
  address: Address,
  protocol: string,
  token0: Address,
  token1: Address,
) => Promise<Record<string, unknown> | null>;

export async function sweepQuietPools(
  pools: PoolMeta[],
  stateCache: Map<string, Record<string, unknown>>,
  fetchPoolState: PoolStateFetcher,
  options: SweepOptions = DEFAULT_SWEEP_OPTIONS,
): Promise<number> {
  const missing = pools.filter((p) => !stateCache.has(p.address.toLowerCase()));
  let hydrated = 0;

  for (const pool of missing.slice(0, options.batchSize)) {
    const state = await fetchPoolState(pool.address, pool.protocol, pool.token0, pool.token1);
    if (state) {
      stateCache.set(pool.address.toLowerCase(), state);
      hydrated++;
    }
  }

  return hydrated;
}
