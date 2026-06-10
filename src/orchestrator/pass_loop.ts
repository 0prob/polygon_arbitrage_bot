import type { RuntimeContext } from "./boot.ts";
import {
  type FoundCycle,
  findCycles,
  enumerateCycles,
  enumerateCyclesBellmanFord,
  routeKeyFromEdges,
  type RoutingGraph,
  buildGraph,
  evaluatePipeline,
  type PipelineOptions,
  ArbInstrumenter,
  fetchMissingPoolState,
  computeMaticRates,
  pruneFailedPools,
  averageObscurity,
  type SwapEdge,
} from "../pipeline/index.ts";
import { FlashLoanSource } from "../core/types/execution.ts";
import { groupCompatibleCandidates, type CandidateExecution } from "../services/execution/service.ts";
import {
  discoverPoolsFromHasura,
  buildStateCacheFromGraphQL,
  fetchTokenMetasFromHasura,
  fetchIndexerProgressFromHasura,
} from "../infra/hypersync/hyperindex_graphql.ts";
import { buildExecutionCandidate } from "../services/execution/candidate.ts";
import type { PoolMeta } from "../core/types/pool.ts";
import type { EventBus } from "../tui/events.ts";
import { privateKeyToAccount } from "viem/accounts";
import { buildStatusPayload, writeStatusFile } from "./status_writer.ts";
import type { PassLoopDeps } from "./loop.ts"; // see loop.ts for history of the (now-removed) duplicated runPipeline extraction
import { toBigInt } from "../core/utils/bigint.ts";
import { isGarbagePool } from "../infra/garbage/garbage-tracker.ts";


function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * LONG-TAIL / LOW-COMPETITION ARBITRAGE STRATEGY
 *
 * Given minimal infrastructure (no custom nodes, no ultra-low-latency private relays
 * on every path, standard public mempool visibility), the bot is structurally
 * disadvantaged in head-to-head races on the hottest, most liquid pairs.
 *
 * Core thesis:
 * - Hot V3 2-hops on major pairs (Uni/Quick main pools) → extremely competitive,
 *   narrow windows, dominated by latency + private orderflow bots.
 * - Obscure V2 factories, DODO PMM pools, Balancer weighted/stable, many Curve pools,
 *   and complex 3-4 hop cross-protocol paths → much lower bot density.
 *
 * These areas reward:
 *   - Correct multi-AMM modeling (this bot's strength)
 *   - Good historical state (HyperIndex advantage)
 *   - Willingness to take smaller but more reliable edges in thin markets
 *
 * Implementation:
 * - finder.ts applies strong negative adjustments to logWeight for cycles containing
 *   high-obscurity protocols (dfyn/ape/mesh/jet/cometh V2s, DODO, Balancer, Curve, Woofi).
 * - This naturally promotes long-tail cycles into the top candidates that get
 *   deep ternary search + execution attempts.
 * - The effect is amplified for 3/4-hop cycles.
 *
 * Result: the limited simulation and execution budget is preferentially spent where
 * this specific bot has a comparative advantage instead of being wasted losing
 * latency wars on saturated paths.
 *
 * Indexer Interaction:
 * The Envio indexer (hyperindex/) should default to broad discovery.
 * Enabling hot-bias in the indexer reduces long-tail pool discovery and should
 * be considered a conservative deviation from this strategy.
 */

const instrumenter = new ArbInstrumenter();



export const DEFAULT_DEPS: PassLoopDeps = {
  buildGraph,
  findCycles,
  enumerateCycles,
  evaluatePipeline,
  discoverPoolsFromHasura,
  buildStateCacheFromGraphQL,
  fetchTokenMetasFromHasura,
  fetchIndexerProgressFromHasura,
  routeKeyFromEdges,
  buildExecutionCandidate,
  instrumenter,
  averageObscurity, // from finder (re-exported via pipeline); matches optional in PassLoopDeps
};


function runRateComputation(
  ctx: RuntimeContext,
  hasuraPoolsCache: PoolMeta[] | null,
  stateCache: Map<string, Record<string, unknown>>,
  cachedRates: Map<string, bigint> | null,
  ratesNeedFullRefresh: boolean,
  pendingFocusTokens: Set<string> | null,
  cycleTokens: Set<string>,
  bus?: EventBus,
): {
  cachedRates: Map<string, bigint>;
  tokenToMaticRates: Map<string, bigint>;
  ratesNeedFullRefresh: boolean;
  pendingFocusTokens: Set<string> | null;
} {
  bus?.emit({ type: "pipeline_stage", stage: "RATES" });
  let rates = cachedRates;
  let needFull = ratesNeedFullRefresh;
  let focus = pendingFocusTokens;

  if (needFull) {
    rates = computeMaticRates(hasuraPoolsCache ?? [], stateCache, ctx.logger, {
      minLiquidityV3: ctx.config.execution.minLiquidityV3Rate,
      seedRates: rates ?? undefined,
    });
    needFull = false;
  } else if (focus && rates) {
    rates = computeMaticRates(hasuraPoolsCache ?? [], stateCache, ctx.logger, {
      minLiquidityV3: ctx.config.execution.minLiquidityV3Rate,
      seedRates: rates,
      focusTokens: focus,
    });
    focus = null;
  } else if (!rates) {
    rates = computeMaticRates(hasuraPoolsCache ?? [], stateCache, ctx.logger, {
      minLiquidityV3: ctx.config.execution.minLiquidityV3Rate,
    });
  }
  if (cycleTokens.size > 0 && rates) {
    const boosted = computeMaticRates(hasuraPoolsCache ?? [], stateCache, ctx.logger, {
      minLiquidityV3: ctx.config.execution.minLiquidityV3Rate,
      seedRates: rates,
      focusTokens: cycleTokens,
    });
    rates = boosted;
  }

  const tokenToMaticRates = rates!;

  return {
    cachedRates: rates,
    tokenToMaticRates,
    ratesNeedFullRefresh: needFull,
    pendingFocusTokens: focus,
  };
}

/**
* Reorg detection + block tracking at LF cadence.
* Runs every lfInterval ms. Returns shouldForceRefresh=true when a reorg
* is detected so the caller can schedule a state refresh.
*/
async function runReorgCheck(
  ctx: RuntimeContext,
  lastReorgCheck: number,
  lfInterval: number,
): Promise<{ lastReorgCheck: number; shouldForceRefresh: boolean }> {
  const now = Date.now();
  if (ctx.reorgDetector && ctx.publicClient && now - lastReorgCheck > lfInterval) {
    const detector = ctx.reorgDetector;
    try {
      const reorged = await detector.checkReorg();
      let shouldForceRefresh = false;
      if (reorged.size > 0) {
        ctx.logger.warn({ reorgedBlocks: [...reorged].join(",") }, "Reorg detected — forcing state refresh");
        detector.clearReorged();
        shouldForceRefresh = true;
        // Fall through to trackBlock to re-establish tracking baseline
      }

      const latest = ctx.hyperSync
        ? await ctx.hyperSync.getBlockByNumber("latest")
        : ctx.hyperRpc
          ? await ctx.hyperRpc.getBlockByNumber("latest")
          : await ctx.publicClient.getBlock({ blockTag: "latest" });
      if (latest?.number && latest?.hash) {
        await detector.trackBlock(Number(latest.number), latest.hash as `0x${string}`);
      }

      return { lastReorgCheck: now, shouldForceRefresh };
    } catch {
      /* best effort */
    }
  }
  return { lastReorgCheck, shouldForceRefresh: false };
}



export async function runPassLoop(ctx: RuntimeContext, deps: PassLoopDeps = DEFAULT_DEPS, bus?: EventBus): Promise<void> {
  ctx.logger.info({}, "runPassLoop started");
  const executorAddress = ctx.config.execution.executorAddress;
  const operatorAccount = privateKeyToAccount(ctx.config.execution.privateKey as `0x${string}`);
  const operatorAddress = operatorAccount.address;

  await Promise.all([ctx.executionService.start(), ctx.mempoolService.start()]);

  // Start WebSocket subscriber if configured
  if (ctx.wsSubscriber) {
    try {
      await ctx.wsSubscriber.start();
      ctx.logger.info({}, "WebSocket subscriber started for real-time events");

      // Wire WebSocket events into mempool + pass loop
      ctx.wsSubscriber.onEvent((event) => {
        if (event.type === "newPendingTx" && event.to) {
          ctx.mempoolService.processPendingTx({
            hash: event.hash,
            to: event.to,
            input: event.input,
            value: event.value,
          });
        }
        if (event.type === "newHead") {
          headTriggered = true;
          lastHeadTime = Date.now();
          if (event.blockNumber > 0) {
            ctx.pendingStateOverlay?.clear();
          }
        }
      });
    } catch (err) {
      ctx.logger.warn({ err }, "Failed to start WebSocket subscriber");
    }
  }

  bus?.emit({ type: "pass_loop_started", intervalMs: 200 });
  ctx.logger.info({}, "Pass loop started with multi-frequency cycles");

  let isPaused = false;
  bus?.on((ev) => {
    if (ev.type === "pause_toggled") {
      isPaused = ev.isPaused;
    }
  });

  let cachedGraph: RoutingGraph | null = null;
  let cachedCycles: FoundCycle[] = [];
  let hasuraPoolsCache: PoolMeta[] | null = null;
  let lastRefreshTime = 0;
  let lastMempoolTraceId: string | undefined = undefined;
  let cachedRates: Map<string, bigint> | null = null;
  let tokenToMaticRates: Map<string, bigint> = new Map();
  let cachedMetas: Map<string, { decimals: number }> | null = null;
  // Rate refresh intent flags — set by LF / pre-fetch paths, consumed by single ensureRates block
  let ratesNeedFullRefresh = false;
  let pendingFocusTokens: Set<string> | null = null;

  const HF_INTERVAL = 200;
  const LF_INTERVAL = 1000;
  const TIER_CHECK_INTERVAL = 5000;
  let lastTierCheck = 0;

  const recentRouteTimestamps = new Map<string, number>();
  // AGENT: DO NOT reduce ROUTE_COOLDOWN_MS below 12000 for the lowInfra path.
  // On poor infrastructure, transaction confirmation latency can exceed 5–8 seconds.
  // A cooldown shorter than confirmation time causes the bot to resubmit the same route
  // while the original tx is still pending in the mempool, wasting gas on a duplicate and
  // risking two competing self-fills if both land. 12s provides a safe margin above the
  // observed 95th-percentile Polygon confirmation time on congested public nodes.
  const lowInfraForCooldown = (ctx.config.rpc.chainstackRps ?? 250) <= 250;
  const ROUTE_COOLDOWN_MS = lowInfraForCooldown ? 12000 : 5000;

  // Block-aligned HF timing: when newHead arrives from Chainstack WS,
  // the sleep between cycles is shortened to ~50ms for immediate re-evaluation.
  // Falls back to normal 200ms polling after HEAD_TIMEOUT_MS without a head.
  let headTriggered = false;
  let lastHeadTime = 0;
  const HEAD_TIMEOUT_MS = 3000;

  ctx.mempoolService.onSignal((signal) => {
    if (signal.type === "new_pool_pending") {
      ctx.logger.info({ txHash: signal.data.txHash }, "New pool deployment detected in mempool! Scheduling rapid discovery.");
      bus?.emit({
        type: "mempool_pending_swap",
        poolPath: signal.data.factoryAddress,
        value: 0n,
        txHash: signal.data.txHash,
        traceId: signal.data.traceId,
      });
    }
    if (signal.type === "large_swap") {
      lastMempoolTraceId = signal.data.traceId;
      bus?.emit({
        type: "mempool_pending_swap",
        poolPath: signal.data.poolAddress,
        value: signal.data.estimatedSwapSize,
        txHash: signal.data.txHash,
        traceId: signal.data.traceId,
      });
      lastRefreshTime = 0;
    }
  });

  let cycleWindowStart = Date.now();
  let lastReorgCheck = 0;
  let lastStatusWriteTime = 0;

  while (ctx.isRunning) {
    if (isPaused) {
      bus?.emit({ type: "pipeline_stage", stage: "IDLE" });
      await sleep(200);
      continue;
    }
    const now = Date.now();
    const startTime = now;
    const currentPassTraceId = lastMempoolTraceId;
    lastMempoolTraceId = undefined;

    // Timing instrumentation for bottleneck analysis (debug only)
    let t_point = Date.now();
    const timings: Record<string, number> | undefined = ctx.config.observability.logLevel === "debug" ? {} : undefined;
    const mark = (name: string) => {
      if (!timings) return;
      timings[name] = Date.now() - t_point;
      t_point = Date.now();
    };

    const cycleWindow = 60000;
    const elapsedCycleWindow = now - cycleWindowStart;
    ctx.metrics.currentCyclesPerMinute = elapsedCycleWindow > 0 ? Math.round((ctx.metrics.cycles * 60000) / elapsedCycleWindow) : 0;
    if (ctx.metrics.currentCyclesPerMinute > ctx.metrics.peakCyclesPerMinute) {
      ctx.metrics.peakCyclesPerMinute = ctx.metrics.currentCyclesPerMinute;
    }
    if (elapsedCycleWindow > cycleWindow) {
      cycleWindowStart = now;
    }

    try {
      ctx.metrics.cycles++;

      if (now - lastTierCheck > TIER_CHECK_INTERVAL) {
        const tier = ctx.tierManager.assess();
        lastTierCheck = now;
        ctx.logger.debug({ tier }, ctx.tierManager.label());
        // Prune stale route cooldown entries
        for (const [key, ts] of recentRouteTimestamps) {
          if (now - ts > ROUTE_COOLDOWN_MS * 2) recentRouteTimestamps.delete(key);
        }
        // Also prune the fetcher failed-pool tracker (prevents slow memory growth)
        pruneFailedPools(now);
      }

      // Reorg safety + block tracking moved out of HF (200ms) hot path.
      // Per AGENTS.md: getBlock sparingly in HF. WS newHead + LF (1s) are the triggers.
      // Heavy serial getBlock calls inside checkReorg were killing HF latency/RPC budget.

      const stateCache = ctx.stateCache;
      const isLfTick = now - lastRefreshTime >= LF_INTERVAL || cachedCycles.length === 0;

      if (isLfTick) {
        const reorgResult = await runReorgCheck(ctx, lastReorgCheck, LF_INTERVAL);
        lastReorgCheck = reorgResult.lastReorgCheck;
        if (reorgResult.shouldForceRefresh) lastRefreshTime = 0;

        hasuraPoolsCache = ctx.stateRefreshService.Pools;
        if (!cachedMetas) {
          cachedMetas = ctx.stateRefreshService.TokenMetas;
        }
        const pools = hasuraPoolsCache;
        bus?.emit({ type: "pipeline_stage", stage: "ENUMERATING" });

        const filteredPools = pools.filter((p) => {
          if (p.fee === 0) return false;
          if (isGarbagePool(p)) return false;

          const protocol = p.protocol.toLowerCase();
          const addr = p.address.toLowerCase();
          if (protocol.includes("v3") || protocol.includes("v4") || protocol.includes("elastic")) {
            const state = stateCache.get(addr);
            if (!state) return false;
            const rawLiq = (state as Record<string, unknown>).liquidity ?? 0;
            const liq = toBigInt(rawLiq, 0n);
            if (liq < ctx.config.execution.minLiquidityV3Rate) {
              return false;
            }
          }
          return true;
        });

        ctx.logger.info(
          { total: pools.length, filtered: filteredPools.length, removed: pools.length - filteredPools.length },
          "Pools filtered for graph building",
        );

        cachedGraph = deps.buildGraph(filteredPools, stateCache);

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
          edgeCount: cachedGraph.adjacency.size,
          cachedCount: stateCache.size,
        });

        const enumStartTime = Date.now();
        const baseMaxPaths = ctx.config.routing.enumerationMaxPaths;
        const rpsForEnum = ctx.config.rpc.chainstackRps ?? 250;
        const lowForEnum = rpsForEnum <= 250;
        const maxPaths = lowForEnum ? Math.min(8000, Math.floor(baseMaxPaths * 0.8)) : baseMaxPaths;
        const MAX_HOPS = ctx.config.routing.maxHops;
        const finderFn = ctx.config.routing.cycleFinder === "bellman-ford" ? enumerateCyclesBellmanFord : deps.enumerateCycles;
        cachedCycles = await finderFn(cachedGraph, MAX_HOPS, maxPaths, (key) => ctx.executionService.tracker.getWinRate(key));

        // Fetch state for pools referenced by current cycles
        const stateClient = ctx.stateClient ?? ctx.publicClient;
        if (pools.length > 0 && cachedCycles.length > 0) {
          try {
            await fetchMissingPoolState(stateClient, stateCache, pools, cachedCycles, [], false);
          } catch (err) {
            ctx.logger.debug?.({ err }, "State refresh fetch failed (will retry next LF)");
          }
        }

        const enumElapsed = Date.now() - enumStartTime;

        const cyclesByHop: Record<number, number> = {};
        for (const cycle of cachedCycles) {
          cyclesByHop[cycle.hopCount] = (cyclesByHop[cycle.hopCount] ?? 0) + 1;
        }
        bus?.emit({
          type: "cycles_enumerated",
          total: cachedCycles.length,
          cyclesByHop,
          elapsedMs: enumElapsed,
        });

        ctx.logger.info(
          { pools: pools.length, filtered: filteredPools.length, cycles: cachedCycles.length, durationMs: enumElapsed },
          "Graph and cycles re-enumerated",
        );

        // LF Rate Computation
        const rateResult = runRateComputation(
          ctx,
          hasuraPoolsCache,
          stateCache,
          cachedRates,
          ratesNeedFullRefresh,
          pendingFocusTokens,
          new Set<string>(), // No specific cycleTokens for a full LF refresh
          bus,
        );
        cachedRates = rateResult.cachedRates;
        tokenToMaticRates = rateResult.tokenToMaticRates;
        ratesNeedFullRefresh = rateResult.ratesNeedFullRefresh;
        pendingFocusTokens = rateResult.pendingFocusTokens;
        lastRefreshTime = now; // Update lastRefreshTime after all LF logic
      }  // end if (isLfTick)

      // ===== HF PATH: Simulation + Execution + Timing (every pass) =====
      const currentCycles = cachedCycles ?? [];


      // === INDEXER LAG DETECTION (early, for graceful degradation decisions) ===
      const INDEXER_LAG_THRESHOLD_BLOCKS = 5000; // ~2+ hours on Polygon
      let currentIndexerLag = 0;
      const hiStatusForLag = ctx.hyperIndexMonitor ? ctx.hyperIndexMonitor.getLastStatus() : undefined;
      if (hiStatusForLag && hiStatusForLag.remote > 0 && hiStatusForLag.synced > 0) {
        currentIndexerLag = Math.max(0, hiStatusForLag.remote - hiStatusForLag.synced);
        if (currentIndexerLag > INDEXER_LAG_THRESHOLD_BLOCKS) {
          ctx.logger.warn(
            {
              lag: currentIndexerLag,
              threshold: INDEXER_LAG_THRESHOLD_BLOCKS,
              synced: hiStatusForLag.synced,
              remote: hiStatusForLag.remote,
            },
            "High indexer lag detected — entering degraded mode (reduced concurrency, higher profit floor)",
          );
        }
      }

      const gasSnapshot = ctx.gasOracle.getSnapshot();
      if (!gasSnapshot) {
        ctx.logger.debug({}, "Waiting for gas oracle snapshot");
        bus?.emit({ type: "pipeline_stage", stage: "IDLE" });
        await sleep(100);
        continue;
      }

      bus?.emit({ type: "gas_snapshot", gasPrice: gasSnapshot.gasPrice });

      // Filter out quarantined routes before simulation to avoid repetitive noise.
      // Prefer cycle.id (pre-computed by enumerateCycles when win-rate scoring is active)
      // to avoid redundant O(N log N) routeKeyFromEdges work.
      const filteredCycles = currentCycles.filter((cycle) => {
        const routeKey = cycle.id ?? deps.routeKeyFromEdges(cycle.edges);
        return !ctx.executionService.isQuarantined(routeKey);
      });

      if (filteredCycles.length === 0) {
        bus?.emit({ type: "pipeline_stage", stage: "IDLE" });
        await sleep(HF_INTERVAL);
        continue;
      }

      // Mempool-aware dry run: check pending state before submitting
      if (ctx.dryRunner) {
        await ctx.dryRunner.fetchPendingState();
      }

      bus?.emit({ type: "pipeline_stage", stage: "SIMULATING" });

      // Apply graceful degradation if indexer lag is high
      const isDegraded = currentIndexerLag > INDEXER_LAG_THRESHOLD_BLOCKS;
      const baseConc = ctx.config.routing.concurrency ?? 50;
      let effectiveConcurrency = isDegraded ? Math.max(10, Math.floor(baseConc * 0.4)) : baseConc;
      const rpsConc = ctx.config.rpc.chainstackRps ?? 250;
      if (rpsConc <= 250) {
        // AGENT: DO NOT raise the floor above 4 or remove the 0.5× reduction for lowInfra.
        // Simulation concurrency controls how many Promise.all batches run simultaneously.
        // Higher concurrency does NOT reduce wall-time when the bottleneck is the single-threaded
        // JS event loop — it only increases GC pressure from additional object allocations per
        // ternary-search iteration. Keeping it at max(4, base×0.5) maintains throughput while
        // reducing per-cycle jitter, which is essential for block-aligned HF timing.
        effectiveConcurrency = Math.max(4, Math.floor(effectiveConcurrency * 0.5));
      }
      const effectiveMinProfit = isDegraded
        ? ctx.config.execution.minProfitWei * 2n // Be much more selective when data is stale
        : ctx.config.execution.minProfitWei;

      const options: PipelineOptions = {
        minProfitMaticWei: effectiveMinProfit,
        gasPriceWei: gasSnapshot.gasPrice,
        tokenToMaticRates,
        tokenMetas: cachedMetas ?? undefined,
        slippageBps: ctx.config.execution.slippageBps,
        revertRiskBps: ctx.config.execution.revertRiskBps,
        flashLoanSource: ctx.config.execution.flashLoanSource === "AAVE_V3" ? FlashLoanSource.AAVE_V3 : FlashLoanSource.BALANCER,
        ternarySearchIterations: ctx.config.routing.ternarySearchIterations,
        maxPriceImpactThreshold: ctx.config.routing.maxPriceImpactThreshold,
        concurrency: effectiveConcurrency,
        roiSafetyCap: ctx.config.execution.roiSafetyCap,
        logger: ctx.logger,
        onProgress: (current, total, profitable) => {
          if (current % 10 === 0 || current === total) {
            bus?.emit({ type: "simulation_progress", current, total, profitable });
          }
        },
      };

      if (isDegraded) {
        ctx.logger.debug(
          { effectiveConcurrency, effectiveMinProfit: effectiveMinProfit.toString() },
          "Running in indexer-lag degraded mode",
        );
      }

      // Focus expensive simulation on cycles where the *start token* has a rate (flash principal is valued; profit asserted in startToken units).
      // Intermediates without rates contribute 0 to gross (conservative) and extreme checks are skipped for them.
      // This allows more of the graph to be evaluated as rate coverage grows slowly from WMATIC bootstrap + stateCache.
      const rateSafeCycles = filteredCycles.filter((cycle) => {
        const startRate = tokenToMaticRates.get(cycle.startToken.toLowerCase()) ?? 0n;
        return startRate > 0n;
      });

      if (rateSafeCycles.length === 0 && filteredCycles.length > 0) {
        ctx.logger.debug(
          { totalFiltered: filteredCycles.length, rates: tokenToMaticRates.size },
          "No rate-covered cycles this pass (coverage still growing)",
        );
      }

      const simStartTime = Date.now();
      const result = await deps.evaluatePipeline(rateSafeCycles, stateCache, options, ctx.pendingStateOverlay);
      const simElapsed = Date.now() - simStartTime;
      mark("simulation");

      ctx.metrics.opportunitiesFound += result.profitableCount;

      // Emit full simulation breakdown for TUI visibility and debugging
      bus?.emit({
        type: "simulation_stats",
        attempted: result.attempted,
        simulated: result.simulated,
        profitable: result.profitableCount,
        noRate: result.noRate,
        prunedMissingState: result.prunedMissingState,
        prunedNoGrossProfit: result.prunedNoGrossProfit,
        prunedInvalidBounds: result.prunedInvalidBounds,
        prunedFinalCheckFailed: result.prunedFinalCheckFailed,
        maxGrossMilliMatic: result.maxGrossProfitMatic !== undefined ? Number(result.maxGrossProfitMatic / 10n ** 15n) : 0,
        durationMs: simElapsed,
        ratesCovered: tokenToMaticRates.size,
        cacheSize: stateCache.size,
        rateSafeCycles: rateSafeCycles.length,
        totalCycles: filteredCycles.length,
      });

      if (result.attempted > 0) {
        const tier = ctx.tierManager.getCurrent();
        if (result.profitable.length > 0 && !ctx.tierManager.shouldExecute()) {
          ctx.logger.debug({ tier, count: result.profitable.length }, "Execution suppressed by degradation tier");
        } else if (result.profitable.length > 0) {
          const candidates: { candidate: CandidateExecution; profitable: (typeof result.profitable)[number]; routeKey: string }[] = [];

          const candidatePromises = result.profitable.map(async (profitable) => {
            if (!ctx.isRunning) return null;

            const routeKey = profitable.cycle.id ?? deps.routeKeyFromEdges(profitable.cycle.edges);

            const lastSubmit = recentRouteTimestamps.get(routeKey);
            if (lastSubmit && now - lastSubmit < ROUTE_COOLDOWN_MS) {
              ctx.logger.debug({ routeKey, lastSubmit, now }, "Route recently submitted, skipping cooldown");
              return null;
            }
            recentRouteTimestamps.set(routeKey, now);

            // Format a readable path for the TUI
            const path = profitable.result.tokenPath.map((t) => t.slice(0, 6)).join(" -> ");
            const roi = Number(profitable.assessment.roi);
            const isNearMiss = roi > 950_000 && roi < 1_000_000;

            if (isNearMiss) {
              ctx.logger.debug(
                {
                  routeKey,
                  roi,
                  profit: profitable.assessment.netProfitAfterGas.toString(),
                  path: profitable.result.tokenPath.join(" -> "),
                },
                "Near-miss opportunity identified",
              );
            }

            if (!profitable.result.profitable) return null;

            // Capture full simulation trace for debugging
            deps.instrumenter.captureTrace(routeKey, profitable.result, stateCache);

            bus?.emit({
              type: "opportunity_found",
              routeKey,
              profitWei: profitable.assessment.netProfitAfterGasMaticWei,
              path,
              roi: profitable.assessment.roi,
            });

            try {
              // Low-competition relaxation:
              // In obscure/long-tail paths the edge tends to persist longer and competition
              // is lower, so we can afford slightly more slippage/revert risk to capture
              // opportunities that stricter parameters would drop.
              const avgObs = deps.averageObscurity ? deps.averageObscurity(profitable.cycle.edges) : 0;
              const obscurityRelax = Math.min(1.0, Math.max(0, avgObs)) * 25; // up to +25 bps on high-obscurity

              const candidate = deps.buildExecutionCandidate(
                profitable,
                { executorAddress, fromAddress: executorAddress },
                {
                  slippageBps: Number(options.slippageBps ?? 50n) + Math.floor(obscurityRelax) * 2, // base from config + obscurity relaxation up to 50bp; removed prior +500 blanket that caused cascading K errors
                  flashLoanSource: options.flashLoanSource === FlashLoanSource.AAVE_V3 ? "AAVE_V3" : "BALANCER",
                  stateCache,
                },
                currentPassTraceId,
              );

              // Mempool-aware dry run after building candidate
              if (ctx.dryRunner) {
                const dryRun = await ctx.dryRunner.dryRun(candidate, operatorAddress);
                if (!dryRun.success) {
                  ctx.logger.warn(
                    {
                      routeKey,
                      reason: dryRun.revertReason || dryRun.error,
                      revertData: dryRun.revertData,
                      calldata: candidate.calldata,
                      target: candidate.targetAddress,
                      profitable: {
                        roi: profitable.assessment.roi,
                        profit: profitable.assessment.netProfitAfterGas.toString(),
                        pools: profitable.cycle.edges.map((e) => e.poolAddress),
                        protocols: profitable.cycle.edges.map((e) => e.protocol),
                      },
                    },
                    "Dry-run against pending state failed, skipping",
                  );
                  // Dump full calldata for AI debug (arb-tx-tools sim) - useful when running `bun run tui`
                  // or headless to feed simulator/abicoder for exact re-runs of failing arbs.
                  try {
                    const { appendFile } = await import("node:fs/promises");
                    const dump =
                      JSON.stringify({
                        ts: Date.now(),
                        routeKey,
                        calldata: candidate.calldata,
                        target: candidate.targetAddress,
                        revertData: dryRun.revertData,
                      }) + "\n";
                    await appendFile("data/failing-calldata.ndjson", dump);
                  } catch {}
                  ctx.executionService.getQuarantineManager().add(routeKey, dryRun.revertReason || dryRun.error);
                  return null;
                }
              }

              return { candidate, profitable, routeKey };
            } catch (err) {
              ctx.logger.error({ err, routeKey }, "Failed to build tx for cycle");
              ctx.metrics.totalErrors++;
              ctx.metrics.lastErrorTime = Date.now();
              ctx.metrics.lastErrorMessage = "Failed to build tx for cycle";
              return null;
            }
          });

          const resolvedCandidates = await Promise.all(candidatePromises);
          for (const res of resolvedCandidates) {
            if (res) candidates.push(res);
          }

          if (candidates.length > 0) {
            bus?.emit({ type: "pipeline_stage", stage: "EXECUTING" });
            const candidateExecs = candidates.map((c) => c.candidate);
            const groups = groupCompatibleCandidates(candidateExecs);

            ctx.logger.info({ total: candidates.length, groups: groups.length }, "Executing opportunities in batches");

            for (const group of groups) {
              if (!ctx.isRunning) break;
              ctx.metrics.executionsAttempted += group.length;

              const groupRouteKeys = group.map((c) => c.routeKey);
              ctx.logger.info({ groupSize: group.length, routeKeys: groupRouteKeys }, "Executing batch");

              // Emit submitted event for each candidate in the group
              for (const routeKey of groupRouteKeys) {
                bus?.emit({ type: "execution_submitted", routeKey });
              }

              for (const c of candidates) {
                bus?.emit({
                  type: "execution_attempt",
                  protocolPath: c.profitable.cycle.edges.map((e: SwapEdge) => e.protocol).join("→"),
                  hopCount: c.profitable.cycle.hopCount,
                  expectedProfit: c.profitable.assessment.netProfitAfterGasMaticWei,
                  txHash: undefined,
                });
              }

              const results =
                group.length === 1 ? [await ctx.executionService.execute(group[0])] : await ctx.executionService.batchExecute(group);

              for (let i = 0; i < results.length; i++) {
                const execResult = results[i];
                const routeKey = groupRouteKeys[i];
                const execDetails = candidates.find((c) => c.routeKey === routeKey);
                const protocolPath = execDetails?.profitable.cycle.edges.map((e: SwapEdge) => e.protocol).join("→");
                const hopCount = execDetails?.profitable.cycle.hopCount;

                if (execResult.success) {
                  ctx.metrics.executionsSuccessful++;
                  ctx.logger.info({ txHash: execResult.txHash, routeKey }, "Transaction submitted successfully");

                  // Try to get actual profit from tracker if available
                  const tracked = ctx.executionService.tracker.getRecentRecords(10).find((e) => e.txHash === execResult.txHash);
                  const cand = candidates.find((c) => c.routeKey === routeKey);
                  let profitWei = 0n;
                  if (cand) {
                    const startRate = tokenToMaticRates.get(cand.profitable.cycle.startToken.toLowerCase()) ?? 0n;
                    const profitInTokens = tracked ? tracked.profit : cand.profitable.assessment.netProfitAfterGas;
                    if (startRate > 0n) {
                      profitWei = (profitInTokens * startRate) / 1000000000000000000n;
                    } else {
                      profitWei = cand.profitable.assessment.netProfitAfterGasMaticWei;
                    }
                  }

                  bus?.emit({
                    type: "execution_result",
                    routeKey,
                    success: true,
                    txHash: execResult.txHash,
                    profitWei,
                    traceMessages: execResult.traceMessages,
                    protocolPath,
                    hopCount,
                  });
                } else if (execResult.error === "reverted") {
                  ctx.metrics.executionReverts++;
                  ctx.logger.warn({ routeKey }, "Transaction reverted on chain");
                  bus?.emit({
                    type: "execution_result",
                    routeKey,
                    success: false,
                    error: "reverted",
                    traceMessages: execResult.traceMessages,
                    protocolPath,
                    hopCount,
                  });
                } else {
                  ctx.metrics.executionsFailed++;
                  ctx.logger.warn({ error: execResult.error, routeKey }, "Execution failed");
                  ctx.metrics.totalErrors++;
                  ctx.metrics.lastErrorTime = Date.now();
                  ctx.metrics.lastErrorMessage = "Execution failed: " + (execResult.error ?? "");
                  bus?.emit({
                    type: "execution_result",
                    routeKey,
                    success: false,
                    error: execResult.error,
                    traceMessages: execResult.traceMessages,
                    protocolPath,
                    hopCount,
                  });
                }
              }
            }
          }
        }
      }
      mark("execution");

      const elapsed = Date.now() - startTime;
      ctx.metrics.lastCycleDurationMs = elapsed;

      // Minimal HF budget instrumentation (P2 item from debug pass).
      // After previous purges (reorg/getBlock moved out), the loop should comfortably stay < 160 ms.
      // If we ever regress and start doing heavy work in the 200 ms path, this will scream.
      const HF_BUDGET_MS = 160;
      if (elapsed > HF_BUDGET_MS) {
        ctx.logger.debug(
          { elapsed, budget: HF_BUDGET_MS, cycles: ctx.metrics.cycles, ...(timings ? { timings } : {}) },
          "HF cycle exceeded budget — possible hot-path regression (reorg, heavy RPC, or expensive simulation)",
        );
      }
      if (!ctx.metrics.maxHotPathDurationMs || elapsed > ctx.metrics.maxHotPathDurationMs) {
        ctx.metrics.maxHotPathDurationMs = elapsed;
      }
      const trackerSummary = ctx.executionService.tracker.summary;
      ctx.metrics.executionReverts = trackerSummary.totalReverts;
      ctx.metrics.trackedRoutes = trackerSummary.trackedRoutes;
      // Calculate dynamic MATIC price in USD from tokenToMaticRates (derived from USDC / Bridged USDC / USDT / DAI)
      let maticPriceUsd = 0.7;
      if (tokenToMaticRates) {
        const usdcAddress = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359".toLowerCase();
        const usdceAddress = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174".toLowerCase();
        const usdtAddress = "0xc2132d05d31c914a87c6611c10748aeb04b58e8f".toLowerCase();
        const daiAddress = "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063".toLowerCase();

        const usdcRate = tokenToMaticRates.get(usdcAddress) || tokenToMaticRates.get(usdceAddress) || tokenToMaticRates.get(usdtAddress);
        if (usdcRate && usdcRate > 0n) {
          maticPriceUsd = 1e30 / Number(usdcRate);
        } else {
          const daiRate = tokenToMaticRates.get(daiAddress);
          if (daiRate && daiRate > 0n) {
            maticPriceUsd = 1e18 / Number(daiRate);
          }
        }
      }

      const isRpcConnected = ctx.rpcCircuit.isHealthy();
      const isHasuraConnected = ctx.hasuraCircuit.isHealthy();
      const isWsConnected = !!ctx.wsSubscriber && ctx.wsSubscriber.isConnected();

      // Enrich heartbeat with profitability & performance metrics for TUI
      const trackerSummary2 = ctx.executionService.tracker.summary;
      const successRateVal =
        trackerSummary2.totalAttempts > 0 ? Math.round((trackerSummary2.totalSuccesses / trackerSummary2.totalAttempts) * 100) : 0;

      bus?.emit({
        type: "heartbeat",
        elapsedMs: elapsed,
        cycles: ctx.metrics.cycles,
        totalErrors: ctx.metrics.totalErrors,
        indexerLag: currentIndexerLag,
        gasPrice: gasSnapshot?.gasPrice,
        rpcConnected: isRpcConnected,
        hasuraConnected: isHasuraConnected,
        wsConnected: isWsConnected,
        maticPriceUsd,
        cyclesPerMin: ctx.metrics.currentCyclesPerMinute,
        peakCpm: ctx.metrics.peakCyclesPerMinute,
        successRate: successRateVal,
        maxHotPathMs: ctx.metrics.maxHotPathDurationMs,
        trackedRoutes: trackerSummary2.trackedRoutes,
      });
      // Only emit connection_status on actual transitions to avoid per-cycle bus noise
      bus?.emit({ type: "connection_status", subsystem: "rpc", status: isRpcConnected ? "connected" : "disconnected" });
      bus?.emit({ type: "connection_status", subsystem: "hasura", status: isHasuraConnected ? "connected" : "disconnected" });
      bus?.emit({ type: "connection_status", subsystem: "ws", status: isWsConnected ? "connected" : "disconnected" });
      const hiStatus = ctx.hyperIndexMonitor ? ctx.hyperIndexMonitor.getLastStatus() : undefined;

      const payload = buildStatusPayload(
        ctx.metrics,
        gasSnapshot.gasPrice,
        hasuraPoolsCache?.length ?? 0,
        hiStatus
          ? {
              synced: hiStatus.synced,
              remote: hiStatus.remote,
              lag: hiStatus.lag,
              syncRate: hiStatus.syncRate,
              healthy: ctx.hyperIndexMonitor!.isHealthy(),
            }
          : undefined,
      );
      if (now - lastStatusWriteTime > 1000) {
        lastStatusWriteTime = now;
        writeStatusFile(ctx.config.paths.dataDir, payload).catch(() => {});
      }



      // Block-aligned HF timing: skip to next cycle immediately on newHead,
      // fall back to normal 200ms polling after HEAD_TIMEOUT_MS without a head.
      const sinceLastHead = Date.now() - lastHeadTime;
      const isHeadDriven = headTriggered && sinceLastHead < HEAD_TIMEOUT_MS;
      const waitMs = isHeadDriven ? 50 : Math.max(50, HF_INTERVAL - elapsed);
      headTriggered = false;
      bus?.emit({ type: "pipeline_stage", stage: "IDLE" });
      await sleep(waitMs);
    } catch (err) {
      ctx.logger.error({ err }, "Pass loop error");
      ctx.metrics.totalErrors++;
      ctx.metrics.lastErrorTime = Date.now();
      ctx.metrics.lastErrorMessage = "Pass loop error";
      await sleep(HF_INTERVAL);
    }
  }

  ctx.logger.info({}, "Pass loop exited");
}
