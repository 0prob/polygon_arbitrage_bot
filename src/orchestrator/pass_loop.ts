import type { RuntimeContext } from "./boot.ts";
import {
  type FoundCycle,
  findCycles,
  enumerateCycles,
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
} from "../pipeline/index.ts";
import { FlashLoanSource } from "../core/types/execution.ts";
import { groupCompatibleCandidates, type CandidateExecution } from "../services/execution/service.ts";
import { discoverPoolsFromHasura, buildStateCacheFromGraphQL, fetchTokenMetasFromHasura } from "../infra/hypersync/hyperindex_graphql.ts";
import { buildExecutionCandidate } from "../services/execution/candidate.ts";
import type { PoolMeta } from "../core/types/pool.ts";
import type { EventBus } from "../tui/events.ts";
import { privateKeyToAccount } from "viem/accounts";
import { buildStatusPayload, writeStatusFile } from "./status_writer.ts";
import type { PassLoopDeps } from "./loop.ts"; // see loop.ts for history of the (now-removed) duplicated runPipeline extraction
import { toBigInt } from "../core/utils/bigint.ts";

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
 * See hyperindex/src/utils/hot_tokens.ts and `INDEXER_HOT_BIAS` env var.
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
  routeKeyFromEdges,
  buildExecutionCandidate,
  instrumenter,
  averageObscurity: averageObscurity as any, // from finder (re-exported via pipeline)
};

export async function runPassLoop(ctx: RuntimeContext, deps: PassLoopDeps = DEFAULT_DEPS, bus?: EventBus): Promise<void> {
  const executorAddress = ctx.config.execution.executorAddress;
  const operatorAccount = privateKeyToAccount(ctx.config.execution.privateKey as `0x${string}`);
  const operatorAddress = operatorAccount.address;

  await ctx.executionService.start();
  await ctx.mempoolService.start();

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
        }
      });
    } catch (err) {
      ctx.logger.warn({ err }, "Failed to start WebSocket subscriber");
    }
  }

  bus?.emit({ type: "pass_loop_started", intervalMs: 200 });
  ctx.logger.info({}, "Pass loop started with multi-frequency cycles");

  let cachedGraph: RoutingGraph | null = null;
  let cachedCycles: FoundCycle[] = [];
  let hasuraPoolsCache: PoolMeta[] | null = null;
  let lastRefreshTime = 0;
  let lastFullRefreshTime = 0;
  let lastDiscoveryTime = 0;
  let lastPoolsCount = 0;
  let cachedRates: Map<string, bigint> | null = null;
  let cachedMetas: Map<string, { decimals: number }> | null = null;
  // Rate refresh intent flags — set by LF / pre-fetch paths, consumed by single ensureRates block
  let ratesNeedFullRefresh = false;
  let pendingFocusTokens: Set<string> | null = null;

  const HF_INTERVAL = 200;
  const LF_INTERVAL = 1000;
  const DISCOVERY_INTERVAL = 60000;
  const MAX_HOPS = ctx.config.routing.maxHops;
  const TIER_CHECK_INTERVAL = 5000;
  let preFetchCounter = 0;
  let lastTierCheck = 0;

  // ... rest of the setup ...

  const recentRouteTimestamps = new Map<string, number>();
  const ROUTE_COOLDOWN_MS = 5000;

  // Block-aligned HF timing: when newHead arrives from Chainstack WS,
  // the sleep between cycles is shortened to ~50ms for immediate re-evaluation.
  // Falls back to normal 200ms polling after HEAD_TIMEOUT_MS without a head.
  let headTriggered = false;
  let lastHeadTime = 0;
  const HEAD_TIMEOUT_MS = 3000;

  ctx.mempoolService.onSignal((signal) => {
    if (signal.type === "new_pool_pending") {
      ctx.logger.info({ txHash: signal.data.txHash }, "New pool deployment detected in mempool! Scheduling rapid discovery.");
      lastDiscoveryTime = 0;
    }
    if (signal.type === "large_swap") {
      ctx.logger.info(
        { pool: signal.data.poolAddress, size: signal.data.estimatedSwapSize.toString(), txHash: signal.data.txHash },
        "Large swap detected in mempool — triggering fast re-simulation",
      );
      lastRefreshTime = 0;
    }
  });

  let cycleWindowStart = Date.now();
  let lastReorgCheck = 0;

  while (ctx.isRunning) {
    const now = Date.now();
    const startTime = now;

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

      let pools = hasuraPoolsCache ?? ctx.getPools();

      if (pools.length === 0 || (now - lastDiscoveryTime > DISCOVERY_INTERVAL && ctx.tierManager.shouldDiscover())) {
        bus?.emit({ type: "pipeline_stage", stage: "DISCOVERY" });
        const graphqlUrl = ctx.config.hasuraUrl;
        const secret = ctx.config.hasuraSecret;
        if (pools.length === 0) {
          ctx.logger.info({}, "No pools — discovering from Hasura");
        } else {
          ctx.logger.info({}, "Polling Hasura for new pools");
        }

        lastDiscoveryTime = now; // Update even if we fail, to avoid infinite polling
        try {
          const discoveryStartTime = Date.now();
          const hasuraPools = await ctx.rpcCircuit.execute(
            () => deps.discoverPoolsFromHasura(graphqlUrl, secret),
            async () => {
              ctx.logger.warn({}, "Hasura circuit open, returning empty pool list");
              return [];
            },
          );
          const discoveryElapsed = Date.now() - discoveryStartTime;

          if (hasuraPools.length > 0) {
            // Resilience: don't replace a large pool list with a tiny one (less than 10% of previous size)
            // unless the previous list was very small or this is the first discovery.
            if (pools.length > 100 && hasuraPools.length < pools.length / 10) {
              ctx.logger.warn(
                { previous: pools.length, discovered: hasuraPools.length },
                "Suspiciously low number of pools discovered, keeping previous list",
              );
            } else {
              hasuraPoolsCache = hasuraPools.map((p) => ({
                address: p.address as `0x${string}`,
                protocol: p.protocol,
                token0: (p.tokens[0] ?? "") as `0x${string}`,
                token1: (p.tokens[1] ?? "") as `0x${string}`,
                tokens: p.tokens as `0x${string}`[],
                fee: p.fee,
              }));
              pools = hasuraPoolsCache;
              ctx.logger.info({ discovered: pools.length, durationMs: discoveryElapsed }, "Updated pools from Hasura");
            }
          } else if (hasuraPoolsCache === undefined) {
            hasuraPoolsCache = []; // Mark as discovered even if empty
          }
        } catch (e) {
          ctx.logger.warn({ err: e }, "Failed to discover pools from Hasura");
          ctx.metrics.totalErrors++;
          ctx.metrics.lastErrorTime = Date.now();
          ctx.metrics.lastErrorMessage = "Failed to discover pools from Hasura";
        }
      }

      const stateCache = ctx.stateCache;

      const shouldReEnumerate = now - lastRefreshTime >= LF_INTERVAL;

      // needsEnumerationRebuild is used to decide when to (re)compute filteredPools + enumerate.
      // We keep the original pools.length-triggered build behavior so that cachedGraph is
      // always populated before the LF block; the enumeration block will overwrite with a
      // filtered graph on re-enumeration cycles (restoring pre-fix double-build on the rare
      // discovery+LF coincidence, while the important wins — single filtered build on steady
      // LF, and filteredPools computed only on actual rebuilds — remain).
      const needsEnumerationRebuild = shouldReEnumerate || !cachedGraph;

      if (lastPoolsCount !== pools.length) {
        cachedGraph = deps.buildGraph(pools, stateCache);
        lastPoolsCount = pools.length;
        ctx.graphUpdater?.resetRebuildCounter();
      } else if (ctx.graphUpdater && cachedGraph && !needsEnumerationRebuild) {
        // Incremental update: apply new pool states without full rebuild.
        // Guarded by !needsEnumerationRebuild so we don't waste work on a graph
        // that the block below will immediately replace.
        for (const pool of pools) {
          const addr = pool.address.toLowerCase();
          const state = stateCache.get(addr);
          if (state) {
            ctx.graphUpdater.applyPoolStateUpdate(cachedGraph, addr, state);
          }
        }
      }

      // Low-frequency maintenance: Refresh all state and re-calculate rates
      if (shouldReEnumerate && pools.length > 0) {
        bus?.emit({ type: "pipeline_stage", stage: "DISCOVERY" });
        try {
          const graphqlUrl = ctx.config.hasuraUrl;
          const secret = ctx.config.hasuraSecret;
          const gqlCache = await ctx.hasuraCircuit.execute(() => deps.buildStateCacheFromGraphQL(graphqlUrl, secret));
          let newEntries = 0;
          for (const [addr, state] of gqlCache.entries()) {
            if (!ctx.stateCache.has(addr)) {
              ctx.stateCache.set(addr, state);
              newEntries++;
            }
          }
          cachedMetas = await deps.fetchTokenMetasFromHasura(graphqlUrl, secret);
          ctx.logger.info({ entries: gqlCache.size, metas: cachedMetas.size, newEntries }, "State and TokenMeta refreshed from HyperIndex");
        } catch (err) {
          ctx.logger.warn({ err }, "Failed to refresh state from HyperIndex, falling back to RPC");
        }

        // Force-refresh state via RPC for ALL pools — HyperIndex data may be
        // stale (from an older indexed block) and is now only used for pools
        // without existing state. RPC gives us current on-chain prices.
        // (currentCycles is ignored on forceRefresh; we use the real `pools` list directly)
        await fetchMissingPoolState(ctx.publicClient, stateCache, pools, [], true);
        // (return value ignored on full refresh; we still want full rate recompute)

        // Signal that rates must be fully recomputed from scratch after the bulk state refresh.
        // Actual computeMaticRates call is consolidated below to guarantee exactly one call per pass.
        ratesNeedFullRefresh = true;
        pendingFocusTokens = null;

        // Track that we just did a full refresh to avoid redundant pre-fetch below
        lastFullRefreshTime = now;
      }

      if (needsEnumerationRebuild) {
        bus?.emit({ type: "pipeline_stage", stage: "ENUMERATING" });

        // Compute filteredPools only on actual rebuilds (LF or first run), not every HF pass.
        // Cache the filtered result keyed by pools.length to avoid redundant .filter() work.
        // We intentionally key only on length: discovery changes the array reference and length,
        // and the LF cadence already limits how often this runs.
        const filteredPools = pools.filter((p) => {
          const protocol = p.protocol.toLowerCase();
          const addr = p.address.toLowerCase();
          if (protocol.includes("v3") || protocol.includes("v4") || protocol.includes("elastic")) {
            const state = stateCache.get(addr);
            if (!state) return false; // Exclude if no state
            const rawLiq = (state as Record<string, unknown>).liquidity ?? 0;
            const liq = toBigInt(rawLiq, 0n);
            if (liq < ctx.config.execution.minLiquidityV3Rate) {
              if (addr === "0x56ff3a6fa5476c5fd28af7616d8bb35e50a47a81") {
                ctx.logger.debug(
                  { addr, liq: liq.toString(), floor: ctx.config.execution.minLiquidityV3Rate.toString() },
                  "Specifically filtered 0x56ff",
                );
              }
              return false;
            }
          }
          return true;
        });

        ctx.logger.info(
          {
            total: pools.length,
            filtered: filteredPools.length,
            removed: pools.length - filteredPools.length,
          },
          "Pools filtered for graph building",
        );

        // Build the enumeration graph from the filtered set (single build, no double-call)
        cachedGraph = deps.buildGraph(filteredPools, stateCache);

        const enumStartTime = Date.now();
        cachedCycles = deps.enumerateCycles(cachedGraph!, MAX_HOPS, ctx.config.routing.enumerationMaxPaths, (key) =>
          ctx.executionService.tracker.getWinRate(key),
        );
        const enumElapsed = Date.now() - enumStartTime;
        lastRefreshTime = now;
        ctx.logger.info(
          {
            pools: pools.length,
            filtered: filteredPools.length,
            cycles: cachedCycles.length,
            durationMs: enumElapsed,
          },
          "Graph and cycles re-enumerated",
        );
      }

      const currentCycles = cachedCycles;

      if (currentCycles.length === 0) {
        bus?.emit({ type: "pipeline_stage", stage: "IDLE" });
        await sleep(HF_INTERVAL);
        continue;
      }

      // High-frequency pre-fetch: Only for pools in current cycles
      // Skip if we just did a full refresh in the same pass
      preFetchCounter++;
      if (lastFullRefreshTime !== now && (shouldReEnumerate || preFetchCounter % 5 === 0)) {
        const justUpdated = await fetchMissingPoolState(ctx.publicClient, stateCache, pools, currentCycles, false);

        // Build focus tokens from the pools we actually refreshed this round.
        // O(1) lookup via address map instead of O(N) pools.find() per updated address.
        const focusTokens = new Set<string>();
        if (justUpdated.size > 0) {
          const poolByAddr = new Map<string, (typeof pools)[number]>();
          for (const p of pools) poolByAddr.set(p.address.toLowerCase(), p);
          for (const addr of justUpdated) {
            const meta = poolByAddr.get(addr);
            if (meta?.tokens) {
              for (const t of meta.tokens) focusTokens.add(t.toLowerCase());
            }
          }
        }

        // Signal incremental rate update for the consolidated ensureRates block below.
        // Using seed + focus gives cheap dirty-token propagation (P3 optimization).
        pendingFocusTokens = focusTokens.size > 0 ? focusTokens : null;
        if (!cachedMetas) {
          cachedMetas = await deps.fetchTokenMetasFromHasura(ctx.config.hasuraUrl, ctx.config.hasuraSecret);
        }
      }

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

      // Single consolidated rate computation point — guarantees at most one computeMaticRates call per pass.
      // Priority: full refresh (LF) > incremental focus update (pre-fetch) > safety net.
      if (ratesNeedFullRefresh) {
        cachedRates = computeMaticRates(pools, stateCache, ctx.logger, {
          minLiquidityV3: ctx.config.execution.minLiquidityV3Rate,
        });
        ratesNeedFullRefresh = false;
      } else if (pendingFocusTokens && cachedRates) {
        cachedRates = computeMaticRates(pools, stateCache, ctx.logger, {
          minLiquidityV3: ctx.config.execution.minLiquidityV3Rate,
          seedRates: cachedRates,
          focusTokens: pendingFocusTokens,
        });
        pendingFocusTokens = null;
      } else if (!cachedRates) {
        cachedRates = computeMaticRates(pools, stateCache, ctx.logger, {
          minLiquidityV3: ctx.config.execution.minLiquidityV3Rate,
        });
      }
      const tokenToMaticRates = cachedRates!;

      // Filter out quarantined routes before simulation to avoid repetitive noise.
      // Prefer cycle.id (pre-computed by enumerateCycles when win-rate scoring is active)
      // to avoid redundant O(N log N) routeKeyFromEdges work.
      const filteredCycles = currentCycles.filter((cycle) => {
        const routeKey = cycle.id ?? deps.routeKeyFromEdges(cycle.edges, cycle.startToken);
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
      const effectiveConcurrency = isDegraded
        ? Math.max(10, Math.floor((ctx.config.routing.concurrency ?? 50) * 0.4))
        : ctx.config.routing.concurrency;
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

      const simStartTime = Date.now();
      const result = await deps.evaluatePipeline(filteredCycles, stateCache, options);
      const simElapsed = Date.now() - simStartTime;

      ctx.metrics.opportunitiesFound += result.profitableCount;

      if (result.attempted > 0) {
        const tier = ctx.tierManager.getCurrent();
        ctx.logger.info(
          {
            attempted: result.attempted,
            simulated: result.simulated,
            pruned: result.pruned,
            noRate: result.noRate,
            profitable: result.profitableCount,
            maxGrossMatic:
              result.maxGrossProfitMatic !== undefined ? (result.maxGrossProfitMatic / 10n ** 15n).toString() + "mMATIC" : "N/A",
            rates: tokenToMaticRates.size,
            cache: stateCache.size,
            isLowFreq: shouldReEnumerate,
            durationMs: simElapsed,
            tier,
          },
          "Cycle assessment complete",
        );

        if (result.profitable.length > 0 && !ctx.tierManager.shouldExecute()) {
          ctx.logger.info({ tier, count: result.profitable.length }, "Execution suppressed by degradation tier");
        } else if (result.profitable.length > 0) {
          const candidates: { candidate: CandidateExecution; profitable: (typeof result.profitable)[number]; routeKey: string }[] = [];

          for (const profitable of result.profitable) {
            if (!ctx.isRunning) break;

            const routeKey = profitable.cycle.id ?? deps.routeKeyFromEdges(profitable.cycle.edges, profitable.cycle.startToken);

            const lastSubmit = recentRouteTimestamps.get(routeKey);
            if (lastSubmit && now - lastSubmit < ROUTE_COOLDOWN_MS) {
              ctx.logger.debug({ routeKey, lastSubmit, now }, "Route recently submitted, skipping cooldown");
              continue;
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

            if (!profitable.result.profitable) continue;

            // Capture full simulation trace for debugging
            deps.instrumenter.captureTrace(routeKey, profitable.result, stateCache);

            bus?.emit({
              type: "opportunity_found",
              routeKey,
              profitWei: profitable.assessment.netProfitAfterGas,
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
                  slippageBps: Number(options.slippageBps ?? 50n) + Math.floor(obscurityRelax),
                  flashLoanSource: options.flashLoanSource === FlashLoanSource.AAVE_V3 ? "AAVE_V3" : "BALANCER",
                  stateCache,
                },
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
                      profitable: {
                        roi: profitable.assessment.roi,
                        profit: profitable.assessment.netProfitAfterGas.toString(),
                        pools: profitable.cycle.edges.map((e) => e.poolAddress),
                        protocols: profitable.cycle.edges.map((e) => e.protocol),
                      },
                    },
                    "Dry-run against pending state failed, skipping",
                  );
                  ctx.executionService.getQuarantineManager().add(routeKey, dryRun.revertReason || dryRun.error);
                  continue;
                }
              }

              candidates.push({ candidate, profitable, routeKey });
            } catch (err) {
              ctx.logger.error({ err, routeKey }, "Failed to build tx for cycle");
              ctx.metrics.totalErrors++;
              ctx.metrics.lastErrorTime = Date.now();
              ctx.metrics.lastErrorMessage = "Failed to build tx for cycle";
            }
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

              const results =
                group.length === 1 ? [await ctx.executionService.execute(group[0])] : await ctx.executionService.batchExecute(group);

              for (let i = 0; i < results.length; i++) {
                const execResult = results[i];
                const routeKey = groupRouteKeys[i];

                if (execResult.success) {
                  ctx.metrics.executionsSuccessful++;
                  ctx.logger.info({ txHash: execResult.txHash, routeKey }, "Transaction submitted successfully");

                  // Try to get actual profit from tracker if available
                  const tracked = ctx.executionService.tracker.getRecentRecords(10).find((e) => e.txHash === execResult.txHash);
                  const profitWei = tracked
                    ? tracked.profit
                    : candidates.find((c) => c.routeKey === routeKey)?.profitable.assessment.netProfitAfterGas;

                  bus?.emit({
                    type: "execution_result",
                    routeKey,
                    success: true,
                    txHash: execResult.txHash,
                    profitWei,
                    traceMessages: execResult.traceMessages,
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
                  });
                }
              }
            }
          }
        }
      }

      const elapsed = Date.now() - startTime;
      ctx.metrics.lastCycleDurationMs = elapsed;

      // Minimal HF budget instrumentation (P2 item from debug pass).
      // After previous purges (reorg/getBlock moved out), the loop should comfortably stay < 160 ms.
      // If we ever regress and start doing heavy work in the 200 ms path, this will scream.
      const HF_BUDGET_MS = 160;
      if (elapsed > HF_BUDGET_MS) {
        ctx.logger.warn(
          { elapsed, budget: HF_BUDGET_MS, cycles: ctx.metrics.cycles },
          "HF cycle exceeded budget — possible hot-path regression (reorg, heavy RPC, or expensive simulation)",
        );
      }
      if (!ctx.metrics.maxHotPathDurationMs || elapsed > ctx.metrics.maxHotPathDurationMs) {
        ctx.metrics.maxHotPathDurationMs = elapsed;
      }
      const trackerSummary = ctx.executionService.tracker.summary;
      ctx.metrics.executionReverts = trackerSummary.totalReverts;
      ctx.metrics.trackedRoutes = trackerSummary.trackedRoutes;
      bus?.emit({
        type: "heartbeat",
        elapsedMs: elapsed,
        cycles: ctx.metrics.cycles,
        totalErrors: ctx.metrics.totalErrors,
        indexerLag: currentIndexerLag,
      });
      const hiStatus = ctx.hyperIndexMonitor ? ctx.hyperIndexMonitor.getLastStatus() : undefined;

      // Hot-bias mode comes from the same env var the hyperindex sees.
      // When true, the indexer limits pool discovery to "hot" major tokens (conservative mode).
      // Default (false) = broad long-tail discovery (primary strategy).
      const indexerHotBias = process.env.INDEXER_HOT_BIAS === "true" || process.env.INDEXER_HOT_BIAS === "1";
      const discoveryMode: "broad" | "hot-bias" = indexerHotBias ? "hot-bias" : "broad";

      const payload = buildStatusPayload(
        ctx.metrics,
        gasSnapshot.gasPrice,
        pools.length,
        hiStatus
          ? {
              synced: hiStatus.synced,
              remote: hiStatus.remote,
              lag: hiStatus.lag,
              syncRate: hiStatus.syncRate,
              healthy: ctx.hyperIndexMonitor!.isHealthy(),
              discoveryMode,
            }
          : undefined,
      );
      await writeStatusFile(ctx.config.paths.dataDir, payload).catch(() => {});

      // Reorg + block tracking: LF (1s) or explicit newHead from WS only.
      // Previously this (plus checkReorg's serial getBlocks) ran every 200ms — major hot-path violation.
      if (ctx.reorgDetector && ctx.publicClient && now - lastReorgCheck > LF_INTERVAL) {
        lastReorgCheck = now;
        const detector = ctx.reorgDetector; // narrow for the block
        try {
          // Only check on slow cadence
          const reorged = await detector.checkReorg();
          if (reorged.size > 0) {
            ctx.logger.warn({ reorgedBlocks: [...reorged].join(",") }, "Reorg detected — forcing state refresh");
            lastRefreshTime = 0;
            detector.clearReorged();
          }

          const latest = ctx.hyperSync
            ? await ctx.hyperSync.getBlockByNumber("latest")
            : ctx.hyperRpc
              ? await ctx.hyperRpc.getBlockByNumber("latest")
              : await ctx.publicClient.getBlock({ blockTag: "latest" });
          if (latest?.number && latest?.hash) {
            await detector.trackBlock(Number(latest.number), latest.hash as `0x${string}`);
          }
        } catch {
          /* best effort */
        }
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
