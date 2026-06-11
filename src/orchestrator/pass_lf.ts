import type { RuntimeContext } from "./boot.ts";
import type { PassLoopDeps } from "./loop.ts";
import type { PassLoopState } from "./pass_state.ts";
import type { EventBus } from "../tui/events.ts";
import { enumerateCyclesBellmanFord, fetchMissingPoolState } from "../pipeline/index.ts";
import { toBigInt } from "../core/utils/bigint.ts";
import { isGarbagePool } from "../infra/garbage/garbage-tracker.ts";
import { runRateComputation } from "./pass_rates.ts";
import { runReorgCheck } from "./pass_reorg.ts";
import { computeMaticPriceUsd } from "./pass_hf.ts";
import type { RouteStateCache } from "../core/types/route.ts";

const LF_INTERVAL = 1000;

export async function runLfTick(
  ctx: RuntimeContext,
  state: PassLoopState,
  stateCache: RouteStateCache,
  deps: Pick<PassLoopDeps, "buildGraph" | "enumerateCycles" | "routeKeyFromEdges">,
  bus?: EventBus,
): Promise<void> {
  const now = Date.now();

  state.hasuraPoolsCache = ctx.stateRefreshService.Pools;
  const freshMetas = ctx.stateRefreshService.TokenMetas;
  if (freshMetas) {
    state.cachedMetas = freshMetas;
  }
  state.lastRefreshTime = now;

  runReorgCheck(ctx, state.lastReorgCheck, LF_INTERVAL).then((reorgResult) => {
    state.lastReorgCheck = reorgResult.lastReorgCheck;
    if (reorgResult.shouldForceRefresh) state.lastRefreshTime = 0;
  }).catch((err) => {
    ctx.logger.debug?.({ err }, "Background reorg check failed");
  });

  const rateResult = runRateComputation(
    ctx,
    state.hasuraPoolsCache,
    stateCache,
    state.cachedRates,
    state.ratesNeedFullRefresh,
    state.pendingFocusTokens,
    new Set<string>(),
    bus,
  );
  state.cachedRates = rateResult.cachedRates;
  state.tokenToMaticRates = rateResult.tokenToMaticRates;
  if (rateResult.tokenToMaticRates.size > 0) {
    state.maticPriceUsd = computeMaticPriceUsd(rateResult.tokenToMaticRates);
  }
  state.ratesNeedFullRefresh = rateResult.ratesNeedFullRefresh;
  state.pendingFocusTokens = rateResult.pendingFocusTokens;

  if (!state.lfEnumerationInFlight) {
    state.lfEnumerationInFlight = true;
    const pools = state.hasuraPoolsCache.slice();
    const enumStateCache = stateCache;
    const baseMaxPaths = ctx.config.routing.enumerationMaxPaths;
    const rpsForEnum = ctx.config.rpc.chainstackRps ?? 250;
    const lowForEnum = rpsForEnum <= 250;
    const maxPaths = lowForEnum ? Math.min(8000, Math.floor(baseMaxPaths * 0.8)) : baseMaxPaths;
    const MAX_HOPS = ctx.config.routing.maxHops;
    const finderFn = ctx.config.routing.cycleFinder === "bellman-ford" ? enumerateCyclesBellmanFord : deps.enumerateCycles;
    const stateClient = ctx.stateClient ?? ctx.publicClient;

    Promise.resolve().then(async () => {
      bus?.emit({ type: "pipeline_stage", stage: "ENUMERATING" });

      const filteredPools = pools.filter((p) => {
        if (p.fee === 0) return false;
        if (isGarbagePool(p)) return false;
        const protocol = p.protocol.toLowerCase();
        const addr = p.address.toLowerCase();
        if (protocol.includes("v3") || protocol.includes("v4") || protocol.includes("elastic")) {
          const poolState = enumStateCache.get(addr);
          if (!poolState) return false;
          const rawLiq = (poolState as Record<string, unknown>).liquidity ?? 0;
          const liq = toBigInt(rawLiq, 0n);
          if (liq < ctx.config.execution.minLiquidityV3Rate) return false;
        }
        return true;
      });

      ctx.logger.info(
        { total: pools.length, filtered: filteredPools.length, removed: pools.length - filteredPools.length },
        "Pools filtered for graph building",
      );

      const newGraph = deps.buildGraph(filteredPools, enumStateCache);

      bus?.emit({
        type: "graph_stats",
        poolCount: pools.length,
        protocolBreakdown: pools.reduce(
          (acc, p) => {
            const proto = p.protocol.split("_")[0] ?? p.protocol;
            acc[proto] = (acc[proto] ?? 0) + 1;
            return acc;
          },
          {} as Record<string, number>,
        ),
        edgeCount: newGraph.adjacency.size,
        cachedCount: enumStateCache.size,
      });

      const enumStart = Date.now();
      const newCycles = await finderFn(newGraph, MAX_HOPS, maxPaths, (key) => ctx.executionService.tracker.getWinRate(key));
      const enumElapsed = Date.now() - enumStart;

      state.cachedCycles = newCycles;

      const cyclesByHop: Record<number, number> = {};
      for (const cycle of newCycles) {
        cyclesByHop[cycle.hopCount] = (cyclesByHop[cycle.hopCount] ?? 0) + 1;
      }
      bus?.emit({ type: "cycles_enumerated", total: newCycles.length, cyclesByHop, elapsedMs: enumElapsed });
      ctx.logger.info(
        { pools: pools.length, filtered: filteredPools.length, cycles: newCycles.length, durationMs: enumElapsed },
        "Graph and cycles re-enumerated (background)",
      );

      state.lfEnumerationInFlight = false;

      if (pools.length > 0 && newCycles.length > 0) {
        try {
          await fetchMissingPoolState(stateClient, enumStateCache, pools, newCycles, [], false);
        } catch (err) {
          ctx.logger.debug?.({ err }, "Background state fetch failed (will retry next LF)");
        }
      }
    });
  }
}
