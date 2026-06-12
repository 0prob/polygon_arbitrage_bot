import type { RuntimeContext } from "./boot.ts";
import type { PassLoopDeps } from "./loop.ts";
import type { PassLoopState } from "./pass_state.ts";
import type { EventBus } from "../tui/events.ts";
import { enumerateCyclesBellmanFord, fetchMissingPoolState, type FoundCycle } from "../pipeline/index.ts";
import {
  logSampled,
  METRICS_INTERVAL,
  summarizePoolReadiness,
  summarizeRoutingCycles,
} from "../infra/observability/metrics.ts";
import { toBigInt } from "../core/utils/bigint.ts";
import { isGarbagePool } from "../infra/garbage/garbage-tracker.ts";
import { runRateComputation } from "./pass_rates.ts";
import { runReorgCheck } from "./pass_reorg.ts";
import { computeMaticPriceUsd } from "./matic_price.ts";
import { publishHfSnapshot } from "./hf_snapshot.ts";
import { fingerprintPools } from "../core/utils/pool_fingerprint.ts";
import { resolveInfraProfile } from "../config/infra_profile.ts";
import type { RouteStateCache } from "../core/types/route.ts";
import { fetchTicksForCyclePools } from "../pipeline/tick_fetcher.ts";
import { agentDebugLog } from "../infra/observability/debug_agent.ts";

const LF_INTERVAL = 1000;
/** Min gap between full graph re-enumerations when pool set is unchanged. */
const MIN_ENUM_INTERVAL_MS = 30_000;
/** Only prefetch on-chain state for top-scored cycles (matches HF sim cap + headroom). */
function lfFetchCycleCap(ctx: RuntimeContext): number {
  return resolveInfraProfile(ctx.config).maxSimCycles;
}

export async function runLfTick(
  ctx: RuntimeContext,
  state: PassLoopState,
  stateCache: RouteStateCache,
  deps: Pick<PassLoopDeps, "buildGraph" | "enumerateCycles" | "routeKeyFromEdges">,
  bus?: EventBus,
): Promise<void> {
  const now = Date.now();

  await ctx.stateRefreshService.runLfStateRefresh();

  state.hasuraPoolsCache = ctx.stateRefreshService.Pools;
  const freshMetas = ctx.stateRefreshService.TokenMetas;
  if (freshMetas) {
    state.cachedMetas = freshMetas;
  }
  state.lastRefreshTime = now;

  if ((state.hasuraPoolsCache?.length ?? 0) === 0) {
    agentDebugLog(
      "pass_lf.ts:no-pools",
      "LF skipped — Hasura pools empty",
      { rates: state.tokenToMaticRates.size },
      "A",
    );
    return;
  }

  runReorgCheck(ctx, state.lastReorgCheck, LF_INTERVAL).then((reorgResult) => {
    state.lastReorgCheck = reorgResult.lastReorgCheck;
    if (reorgResult.shouldForceRefresh) state.lastRefreshTime = 0;
  }).catch((err) => {
    ctx.logger.debug?.({ err }, "Background reorg check failed");
  });

  const cycleTokens = new Set<string>();
  const cycleTokenCap = 300;
  for (let i = 0; i < state.cachedCycles.length && cycleTokens.size < cycleTokenCap * 3; i++) {
    const c = state.cachedCycles[i];
    cycleTokens.add(c.startToken.toLowerCase());
    for (const e of c.edges) {
      cycleTokens.add(e.tokenIn.toLowerCase());
      cycleTokens.add(e.tokenOut.toLowerCase());
    }
  }
  const rateResult = runRateComputation(
    ctx,
    state.hasuraPoolsCache,
    stateCache,
    state.cachedRates,
    state.ratesNeedFullRefresh || state.tokenToMaticRates.size < 500,
    state.pendingFocusTokens,
    cycleTokens,
    bus,
  );
  state.cachedRates = rateResult.cachedRates;
  state.tokenToMaticRates = rateResult.tokenToMaticRates;
  if (ctx.priceOracle && ctx.config.oracle.enabled !== false) {
    try {
      const { enrichTokenToMaticRates } = await import("../services/oracle/price_oracle.ts");
      state.tokenToMaticRates = await enrichTokenToMaticRates(
        ctx.priceOracle,
        state.tokenToMaticRates,
        cycleTokens,
        ctx.publicClient,
      );
      state.cachedRates = state.tokenToMaticRates;
    } catch (err) {
      ctx.logger.debug?.({ err }, "Oracle rate enrichment failed");
    }
  }
  if (rateResult.tokenToMaticRates.size > 0) {
    if (ctx.priceOracle && ctx.config.oracle.enabled !== false) {
      state.maticPriceUsd = await ctx.priceOracle.getMaticUsd(ctx.publicClient);
    } else {
      state.maticPriceUsd = computeMaticPriceUsd(rateResult.tokenToMaticRates);
    }
  }
  state.ratesNeedFullRefresh = rateResult.ratesNeedFullRefresh;
  state.pendingFocusTokens = rateResult.pendingFocusTokens;
  publishHfSnapshot(state);

  agentDebugLog(
    "pass_lf.ts:post-rates",
    "LF rates refreshed",
    {
      pools: state.hasuraPoolsCache?.length ?? 0,
      rates: state.tokenToMaticRates.size,
      cachedCycles: state.cachedCycles.length,
      stateCacheSize: stateCache.size,
    },
    "A",
  );

  const pools = state.hasuraPoolsCache?.slice() ?? [];
  const poolsFingerprint = fingerprintPools(pools);
  const infra = resolveInfraProfile(ctx.config);
  const enumStale =
    state.cachedCycles.length === 0 ||
    poolsFingerprint !== state.lastPoolsFingerprint ||
    now - state.lastEnumerationTime >= MIN_ENUM_INTERVAL_MS;

  if (!state.lfEnumerationInFlight && enumStale && pools.length > 0) {
    state.lfEnumerationInFlight = true;
    const enumStateCache = stateCache;
    const baseMaxPaths = ctx.config.routing.enumerationMaxPaths;
    const maxPaths = Math.min(infra.enumMaxPathsCap, Math.floor(baseMaxPaths * infra.enumMaxPathsScale));
    const MAX_HOPS = ctx.config.routing.maxHops;
    const finderFn = ctx.config.routing.cycleFinder === "bellman-ford" ? enumerateCyclesBellmanFord : deps.enumerateCycles;
    const stateClient = ctx.stateClient ?? ctx.publicClient;

    Promise.resolve()
      .then(async () => {
      bus?.emit({ type: "pipeline_stage", stage: "ENUMERATING" });

      let filteredFeeZero = 0;
      let filteredGarbage = 0;
      let filteredV3NoState = 0;
      let filteredV3LowLiq = 0;
      const filteredPools = pools.filter((p) => {
        if (p.fee === 0) {
          filteredFeeZero++;
          return false;
        }
        if (isGarbagePool(p)) {
          filteredGarbage++;
          return false;
        }
        const protocol = p.protocol.toLowerCase();
        const addr = p.address.toLowerCase();
        if (protocol.includes("v3") || protocol.includes("v4") || protocol.includes("elastic")) {
          const poolState = enumStateCache.get(addr);
          if (!poolState) {
            filteredV3NoState++;
            // Keep in graph for token connectivity; findCycles skips no-state edges until fetch fills cache.
          } else {
            const rawLiq = (poolState as Record<string, unknown>).liquidity ?? 0;
            const liq = toBigInt(rawLiq, 0n);
            if (liq < ctx.config.execution.minLiquidityV3Rate) {
              filteredV3LowLiq++;
              return false;
            }
          }
        }
        return true;
      });

      ctx.logger.info(
        {
          total: pools.length,
          filtered: filteredPools.length,
          removed: pools.length - filteredPools.length,
          filteredFeeZero,
          filteredGarbage,
          filteredV3NoState,
          filteredV3LowLiq,
        },
        "Pools filtered for graph building",
      );

      const newGraph = deps.buildGraph(filteredPools, enumStateCache);

      let poolsWithState = 0;
      for (const p of filteredPools) {
        if (enumStateCache.has(p.address.toLowerCase())) poolsWithState++;
      }
      logSampled(
        ctx.logger,
        "lf:graph",
        "debug",
        "Routing graph built",
        {
          poolsTotal: pools.length,
          poolsFiltered: filteredPools.length,
          poolsWithState,
          edgeTokens: newGraph.tokens.size,
          adjacencyNodes: newGraph.adjacency.size,
          stateCacheSize: enumStateCache.size,
        },
        METRICS_INTERVAL.lfGraph,
      );

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
      const winRateFn = (key: string) => ctx.executionService.tracker.getWinRate(key);
      // Short-hop pass: DFS maxCycles cap fills with 5-hop before 2-hop are discovered.
      const shortHopCap = Math.min(2000, Math.floor(maxPaths * 0.4));
      const shortCycles = await finderFn(newGraph, 3, shortHopCap, winRateFn);
      const longCycles = await finderFn(newGraph, MAX_HOPS, maxPaths, winRateFn);
      const merged = new Map<string, FoundCycle>();
      for (const c of shortCycles) {
        const key = c.id ?? deps.routeKeyFromEdges(c.edges);
        merged.set(key, c);
      }
      for (const c of longCycles) {
        const key = c.id ?? deps.routeKeyFromEdges(c.edges);
        const existing = merged.get(key);
        if (!existing || (c.score ?? Infinity) < (existing.score ?? Infinity)) {
          merged.set(key, c);
        }
      }
      const newCycles = Array.from(merged.values());
      newCycles.sort((a, b) => (a.score ?? Infinity) - (b.score ?? Infinity));
      const enumElapsed = Date.now() - enumStart;

      state.cachedCycles = newCycles;
      publishHfSnapshot(state);

      logSampled(
        ctx.logger,
        "lf:cycles",
        "debug",
        "Cycles enumerated",
        summarizeRoutingCycles(newCycles),
        METRICS_INTERVAL.lfCycles,
      );

      const cyclesByHop: Record<number, number> = {};
      for (const cycle of newCycles) {
        cyclesByHop[cycle.hopCount] = (cyclesByHop[cycle.hopCount] ?? 0) + 1;
      }
      bus?.emit({ type: "cycles_enumerated", total: newCycles.length, cyclesByHop, elapsedMs: enumElapsed });
      ctx.logger.info(
        { pools: pools.length, filtered: filteredPools.length, cycles: newCycles.length, durationMs: enumElapsed },
        "Graph and cycles re-enumerated (background)",
      );

      agentDebugLog(
        "pass_lf.ts:post-enum",
        "LF enumeration complete",
        { cycles: newCycles.length, filteredPools: filteredPools.length, enumMs: enumElapsed },
        "A",
      );

      state.lastPoolsFingerprint = poolsFingerprint;
      state.lastEnumerationTime = Date.now();
      state.hfSimOffset = 0;

      if (newCycles.length > 0) {
        const fetchCap = lfFetchCycleCap(ctx);
        const cyclesForFetch =
          newCycles.length > fetchCap ? newCycles.slice(0, fetchCap) : newCycles;
        try {
          await fetchMissingPoolState(stateClient, enumStateCache, pools, cyclesForFetch, [], false, ctx.logger);
          if (ctx.config.routing.tickFetchEnabled !== false) {
            await fetchTicksForCyclePools(stateClient, enumStateCache, cyclesForFetch, pools, {
              wordRange: ctx.config.routing.tickWordRange ?? 3,
              refreshOnMove: ctx.config.routing.tickRefreshOnMove !== false,
            });
          }
          logSampled(
            ctx.logger,
            "lf:pool-ready",
            "debug",
            "Sim pool readiness",
            summarizePoolReadiness(cyclesForFetch, enumStateCache, fetchCap),
            METRICS_INTERVAL.lfPoolReady,
          );
        } catch (err) {
          ctx.logger.debug?.({ err }, "Background state fetch failed (will retry next LF)");
        }
      }
    })
      .catch((err) => {
        ctx.logger.error({ err }, "Background cycle enumeration failed");
      })
      .finally(() => {
        state.lfEnumerationInFlight = false;
      });
  }
}
