import { mapWithConcurrency } from "../../core/utils/concurrency.ts";
import type { Address } from "../../core/types/common.ts";
import type { PoolMeta } from "../../core/types/pool.ts";

export interface WarmupOptions {
  maxSyncPools: number;
  maxSyncV3Pools: number;
  maxSyncOneHubPools: number;
}

export const DEFAULT_WARMUP_OPTIONS: WarmupOptions = {
  maxSyncPools: 500,
  maxSyncV3Pools: 50,
  maxSyncOneHubPools: 100,
};

export type PoolStateFetcher = (
  address: Address,
  protocol: string,
  token0: Address,
  token1: Address,
) => Promise<Record<string, unknown> | null>;

async function syncBatch(
  pools: PoolMeta[],
  fetchPoolState: PoolStateFetcher,
  stateCache: Map<string, Record<string, unknown>>,
): Promise<void> {
  const results = await mapWithConcurrency(
    pools,
    25,
    async (pool: PoolMeta) => {
      const state = await fetchPoolState(pool.address, pool.protocol, pool.token0, pool.token1);
      return { addr: pool.address.toLowerCase(), state: state as Record<string, unknown> | null };
    },
  );
  for (const { addr, state } of results) {
    if (state) stateCache.set(addr, state);
  }
}

export async function warmupStateCache(
  pools: PoolMeta[],
  hubTokens: readonly Address[],
  fetchPoolState: PoolStateFetcher,
  options: WarmupOptions = DEFAULT_WARMUP_OPTIONS,
): Promise<Map<string, Record<string, unknown>>> {
  const stateCache = new Map<string, Record<string, unknown>>();
  const hubSet = new Set(hubTokens.map((t) => t.toLowerCase()));
  const { maxSyncPools, maxSyncV3Pools } = options;

  const v2Pools = pools.filter((p) => p.protocol.includes("V2"));
  const v3Pools = pools.filter((p) => p.protocol.includes("V3"));
  const hubV2 = v2Pools.filter((p) => (p.tokens ?? []).some((t) => hubSet.has(t.toLowerCase())));
  await syncBatch(hubV2.slice(0, maxSyncPools), fetchPoolState, stateCache);

  const hubV3 = v3Pools.filter((p) => (p.tokens ?? []).some((t) => hubSet.has(t.toLowerCase())));
  await syncBatch(hubV3.slice(0, maxSyncV3Pools), fetchPoolState, stateCache);

  return stateCache;
}
