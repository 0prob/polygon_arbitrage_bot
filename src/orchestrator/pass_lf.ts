import type { RuntimeContext } from "./boot.ts";
import type { PassLoopDeps } from "./loop.ts";
import type { PassLoopState } from "./pass_state.ts";
import type { EventBus } from "../tui/events.ts";
import { findCyclesMultiPass, findCyclesBellmanFordMultiPass, finalizeEnumeratedCycles, fetchMissingPoolState, type FoundCycle, type CycleSearchPass } from "../pipeline/index.ts";
import { filterPoolsForRouting } from "../pipeline/graph.ts";
import { IncrementalGraphUpdater, syncGraphStateFromCache } from "../pipeline/graph_incremental.ts";
import { normalizePoolAddress } from "../core/utils/normalize.ts";
import {
  logSampled,
  METRICS_INTERVAL,
  summarizePoolReadiness,
  summarizeRoutingCycles,
} from "../infra/observability/metrics.ts";
import { MAJOR_TOKENS } from "../core/constants.ts";
import { runRateComputation } from "./pass_rates.ts";
import { runReorgCheck, invalidateRoutingOnReorg } from "./pass_reorg.ts";
import { computeMaticPriceUsd } from "./matic_price.ts";
import { publishHfSnapshot } from "./hf_snapshot.ts";
import { fingerprintPools } from "../core/utils/pool_fingerprint.ts";
import type { RouteStateCache } from "../core/types/route.ts";
import { refreshSwapUsdValuator } from "../services/mempool/swap_usd_valuation.ts";
import { fetchTicksForCyclePools } from "../pipeline/tick_fetcher.ts";
import { debugBreak, DebugSites } from "../infra/debug/session.ts";
const LF_INTERVAL = 1000;
/** Min gap between oracle enrich passes on the LF path. */
const ORACLE_ENRICH_INTERVAL_MS = 30_000;
/** Min gap between full graph re-enumerations when pool set is unchanged. */
const MIN_ENUM_INTERVAL_MS = 30_000;
/** Faster re-enumeration while no cycles exist (bootstrap/state hydration still in flight). */
const EMPTY_CYCLES_ENUM_INTERVAL_MS = 5_000;
/** Re-enumerate when state cache grows by this many entries with zero cycles cached. */
const STATE_CACHE_GROWTH_REENUM_DELTA = 500;
/** Prefetch on-chain state for this many pools before first enumeration pass. */
const PREFETCH_BEFORE_ENUM_CAP = 2000;
/** Only prefetch on-chain state for top-scored cycles (matches HF sim cap + headroom). */
function lfFetchCycleCap(state: PassLoopState): number {
  return state.infra.maxSimCycles;
}

export async function runLfTick(
  ctx: RuntimeContext,
  state: PassLoopState,
  stateCache: RouteStateCache,
  deps: Pick<
    PassLoopDeps,
    | "buildGraph"
    | "enumerateCycles"
    | "routeKeyFromEdges"
    | "findCyclesMultiPass"
    | "findCyclesBellmanFordMultiPass"
    | "finalizeEnumeratedCycles"
  >,
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
    return;
  }

  const pools = state.hasuraPoolsCache.slice();
  const poolsFingerprint = fingerprintPools(pools);
  if (poolsFingerprint !== state.knownPoolsFingerprint) {
    ctx.mempoolService.setKnownPools(pools.map((p) => p.address));
    state.knownPoolsFingerprint = poolsFingerprint;
  }

  runReorgCheck(ctx, state.lastReorgCheck, LF_INTERVAL).then((reorgResult) => {
    state.lastReorgCheck = reorgResult.lastReorgCheck;
    if (reorgResult.shouldForceRefresh) invalidateRoutingOnReorg(state);
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
  const requestedFullRates = state.ratesNeedFullRefresh || state.tokenToMaticRates.size < 500;
  const rateResult = runRateComputation(
    ctx,
    state.hasuraPoolsCache,
    stateCache,
    state.cachedRates,
    requestedFullRates,
    state.pendingFocusTokens,
    cycleTokens,
    bus,
  );
  state.cachedRates = rateResult.cachedRates;
  state.tokenToMaticRates = rateResult.tokenToMaticRates;
  const cycleTokenKey = [...cycleTokens].sort().join(",");
  const oracleEnrichDue =
    requestedFullRates ||
    !state.lastOracleEnrichTime ||
    now - state.lastOracleEnrichTime >= ORACLE_ENRICH_INTERVAL_MS ||
    state.lastOracleEnrichTokenKey !== cycleTokenKey;
  if (oracleEnrichDue && ctx.priceOracle && ctx.config.oracle.enabled !== false) {
    try {
      const { enrichTokenToMaticRates } = await import("../services/oracle/price_oracle.ts");
      state.tokenToMaticRates = await enrichTokenToMaticRates(
        ctx.priceOracle,
        state.tokenToMaticRates,
        cycleTokens,
        ctx.publicClient,
      );
      state.cachedRates = state.tokenToMaticRates;
      state.lastOracleEnrichTime = now;
      state.lastOracleEnrichTokenKey = cycleTokenKey;
    } catch (err) {
      ctx.logger.debug?.({ err }, "Oracle rate enrichment failed");
    }
  }
  if (rateResult.tokenToMaticRates.size > 0) {
    if (ctx.priceOracle && ctx.config.oracle.enabled !== false) {
      const cachedMaticUsd = ctx.priceOracle.getCachedMaticUsd();
      if (cachedMaticUsd != null && cachedMaticUsd > 0) {
        state.maticPriceUsd = cachedMaticUsd;
      } else {
        state.maticPriceUsd = await ctx.priceOracle.getMaticUsd(ctx.publicClient);
      }
    } else {
      state.maticPriceUsd = computeMaticPriceUsd(rateResult.tokenToMaticRates);
    }
  }
  state.ratesNeedFullRefresh = rateResult.ratesNeedFullRefresh;
  state.pendingFocusTokens = rateResult.pendingFocusTokens;
  refreshSwapUsdValuator(ctx.swapUsdValuator, { ...state, hasuraPoolsCache: state.hasuraPoolsCache }, ctx.priceOracle);
  publishHfSnapshot(state);

  const infra = state.infra;
  const enumInterval =
    state.cachedCycles.length === 0 ? EMPTY_CYCLES_ENUM_INTERVAL_MS : MIN_ENUM_INTERVAL_MS;
  const stateCacheGrew =
    state.cachedCycles.length === 0 &&
    stateCache.liveSize() >= state.lastEnumStateCacheSize + STATE_CACHE_GROWTH_REENUM_DELTA;
  const enumStale =
    poolsFingerprint !== state.lastPoolsFingerprint ||
    stateCacheGrew ||
    now - state.lastEnumerationTime >= enumInterval;

  if (!state.lfEnumerationInFlight && enumStale && pools.length > 0 && ctx.tierManager.shouldEnumerate()) {
    state.lfEnumerationInFlight = true;
    const enumStateCache = stateCache;
    const baseMaxPaths = ctx.config.routing.enumerationMaxPaths;
    const maxPaths = Math.min(infra.enumMaxPathsCap, Math.floor(baseMaxPaths * infra.enumMaxPathsScale));
    const MAX_HOPS = ctx.config.routing.maxHops;
    const stateClient = ctx.stateClient ?? ctx.publicClient;

    Promise.resolve()
      .then(async () => {
      bus?.emit({ type: "pipeline_stage", stage: "ENUMERATING" });

      const {
        filtered: filteredPools,
        filteredFeeZero,
        filteredGarbage,
        filteredV3NoState,
        filteredV3LowLiq,
      } = filterPoolsForRouting(pools, enumStateCache, {
        minLiquidityV3: ctx.config.execution.minLiquidityV3Rate,
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

      // findCycles skips edges without pool state — prefetch once before first enumeration
      // (skip while bootstrap is already filling the cache in StateRefreshService).
      if (state.cachedCycles.length === 0 && !ctx.stateRefreshService.isBootstrapInProgress) {
        const withState = filteredPools.filter((p) => enumStateCache.has(normalizePoolAddress(p.address))).length;
        const targetCoverage = Math.min(filteredPools.length, PREFETCH_BEFORE_ENUM_CAP);
        if (withState < targetCoverage) {
          const prefetchBatch = [...filteredPools]
            .sort((a, b) => {
              const touchesMajor = (pool: typeof a) =>
                (pool.tokens ?? [pool.token0, pool.token1]).some((t) => MAJOR_TOKENS.has(t.toLowerCase()));
              return (touchesMajor(b) ? 1 : 0) - (touchesMajor(a) ? 1 : 0);
            })
            .slice(0, targetCoverage);
          try {
            await fetchMissingPoolState(stateClient, enumStateCache, prefetchBatch, [], [], true, ctx.logger, ctx.poolGraph);
          } catch (err) {
            ctx.logger.debug?.({ err }, "Pre-enumeration pool state prefetch failed");
          }
        }
      }

      const poolSetStable = poolsFingerprint === state.lastPoolsFingerprint;
      if (!state.graphUpdater) {
        state.graphUpdater = new IncrementalGraphUpdater(INCREMENTAL_FULL_REBUILD_INTERVAL);
      }
      const graphUpdater = state.graphUpdater;
      const useIncrementalGraph =
        poolSetStable && state.cachedRoutingGraph != null && !graphUpdater.shouldFullRebuild();

      let newGraph = state.cachedRoutingGraph;
      if (useIncrementalGraph && newGraph) {
        syncGraphStateFromCache(newGraph, filteredPools, enumStateCache, graphUpdater);
        ctx.logger.debug?.(
          { pools: filteredPools.length, poolSetStable: true },
          "Routing graph updated incrementally (pool set stable)",
        );
      } else {
        newGraph = deps.buildGraph(filteredPools, enumStateCache);
        state.cachedRoutingGraph = newGraph;
        if (!poolSetStable) {
          graphUpdater.resetRebuildCounter();
        }
      }

      if (!newGraph) {
        throw new Error("Routing graph unavailable after build/incremental update");
      }

      let poolsWithState = 0;
      for (const p of filteredPools) {
        if (enumStateCache.has(normalizePoolAddress(p.address))) poolsWithState++;
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
      const finalizeFn = deps.finalizeEnumeratedCycles ?? finalizeEnumeratedCycles;
      const cycleCap = Math.min(maxPaths, lfFetchCycleCap(state));
      const twoHopCap = Math.min(1000, Math.floor(maxPaths * 0.25));
      const shortHopCap = Math.min(2000, Math.floor(maxPaths * 0.35));
      const searchPasses: CycleSearchPass[] = [
        { maxHops: 2, maxCycles: twoHopCap },
        { maxHops: 3, maxCycles: shortHopCap },
        { maxHops: MAX_HOPS, maxCycles: maxPaths },
      ];
      const rawCycles =
        ctx.config.routing.cycleFinder === "bellman-ford"
          ? await (deps.findCyclesBellmanFordMultiPass ?? findCyclesBellmanFordMultiPass)(newGraph, searchPasses)
          : await (deps.findCyclesMultiPass ?? findCyclesMultiPass)(newGraph, searchPasses, ctx.logger);
      const newCycles = finalizeFn(newGraph, rawCycles, cycleCap, winRateFn);
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

      debugBreak(DebugSites.LF_ENUM, {
        pools: pools.length,
        cycles: newCycles.length,
        durationMs: enumElapsed,
        stateCacheSize: stateCache.size,
      });

      state.lastPoolsFingerprint = poolsFingerprint;
      state.lastEnumerationTime = Date.now();
      state.lastEnumStateCacheSize = stateCache.liveSize();
      state.hfSimOffset = 0;
      state.cachedRoutingGraph = newGraph;

      if (newCycles.length > 0) {
        const cyclesForFetch = newCycles;
        try {
          await fetchMissingPoolState(stateClient, enumStateCache, pools, cyclesForFetch, [], false, ctx.logger, ctx.poolGraph);
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
            summarizePoolReadiness(cyclesForFetch, enumStateCache, cycleCap),
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
