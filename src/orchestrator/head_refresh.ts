import type { RuntimeContext } from "./boot.ts";
import type { RouteStateCache } from "../core/types/route.ts";
import type { FoundCycle, RoutingGraph } from "../pipeline/types.ts";
import { fetchMissingPoolState } from "../pipeline/fetcher.ts";
import { fetchTicksForCyclePools, collectCyclePoolAddresses } from "../pipeline/tick_fetcher.ts";
import { IncrementalGraphUpdater, syncGraphStateFromCache } from "../pipeline/graph_incremental.ts";
import { normalizePoolAddress } from "../core/utils/normalize.ts";

/** Targeted RPC refresh for cycle pools on newHead. */
export async function refreshCyclePoolsOnHead(
  ctx: RuntimeContext,
  stateCache: RouteStateCache,
  cycles: FoundCycle[],
  maxPools: number = 50,
  routingGraph?: RoutingGraph | null,
  graphUpdater?: IncrementalGraphUpdater,
): Promise<void> {
  if (cycles.length === 0) return;
  const pools = ctx.stateRefreshService.Pools;
  if (pools.length === 0) return;

  const addrs = [...collectCyclePoolAddresses(cycles)].slice(0, maxPools);
  if (addrs.length === 0) return;

  const anchorPools = addrs.map((address) => ({ address }));
  const client = ctx.stateClient ?? ctx.publicClient;
  await fetchMissingPoolState(client, stateCache, pools, cycles.slice(0, 20), anchorPools, true, ctx.logger, ctx.poolGraph);

  if (routingGraph && graphUpdater) {
    const touched = new Set(addrs.map((a) => normalizePoolAddress(a)));
    const poolsToSync = pools.filter((p) => touched.has(normalizePoolAddress(p.address)));
    syncGraphStateFromCache(routingGraph, poolsToSync, stateCache, graphUpdater);
  }

  if (ctx.config.routing.tickFetchEnabled !== false) {
    await fetchTicksForCyclePools(client, stateCache, cycles.slice(0, Math.min(cycles.length, 20)), pools, {
      wordRange: ctx.config.routing.tickWordRange ?? 3,
      refreshOnMove: true,
    });
  }
}
