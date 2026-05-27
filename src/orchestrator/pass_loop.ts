import type { RuntimeContext } from "./boot.ts";
import { type FoundCycle, findCycles, enumerateCycles, routeKeyFromEdges, type RoutingGraph, buildGraph, evaluatePipeline, type PipelineOptions, ArbInstrumenter, fetchMissingPoolState, computeMaticRates } from "../pipeline/index.ts";
import { FlashLoanSource } from "../core/types/execution.ts";
import { groupCompatibleCandidates, type CandidateExecution } from "../services/execution/service.ts";
import { discoverPoolsFromHasura, buildStateCacheFromGraphQL, fetchTokenMetasFromHasura } from "../infra/hypersync/hyperindex_graphql.ts";
import type { PolygonPoolState } from "../services/crosschain/types.ts";
import { buildExecutionCandidate } from "../services/execution/candidate.ts";
import type { PoolMeta } from "../core/types/pool.ts";
import type { EventBus } from "../tui/events.ts";
import { privateKeyToAccount } from "viem/accounts";
import { buildStatusPayload, writeStatusFile } from "./status_writer.ts";

export interface PassLoopDeps {
  buildGraph: typeof buildGraph;
  findCycles: typeof findCycles;
  enumerateCycles: typeof enumerateCycles;
  evaluatePipeline: typeof evaluatePipeline;
  discoverPoolsFromHasura: typeof discoverPoolsFromHasura;
  buildStateCacheFromGraphQL: typeof buildStateCacheFromGraphQL;
  fetchTokenMetasFromHasura: typeof fetchTokenMetasFromHasura;
  routeKeyFromEdges: (edges: any[], startToken: `0x${string}`) => string;
  buildExecutionCandidate: typeof buildExecutionCandidate;
  instrumenter: ArbInstrumenter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
          // Track new head for freshness — the existing LF_INTERVAL handles re-evaluation
          ctx.metrics.currentCyclesPerMinute = ctx.metrics.currentCyclesPerMinute || 1;
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

  const HF_INTERVAL = 200;
  const LF_INTERVAL = 1000;
  const DISCOVERY_INTERVAL = 60000;
  const MAX_HOPS = ctx.config.routing.maxHops;
  const TIER_CHECK_INTERVAL = 5000;
  let preFetchCounter = 0;
  let lastTierCheck = 0;

  // ... rest of the setup ...

  // Track simulation block for reorg safety
  let lastSimulationBlock = 0;

  const recentRouteTimestamps = new Map<string, number>();
  const ROUTE_COOLDOWN_MS = 5000;

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

  // Start cross-chain scanner in a dedicated background loop if enabled
  if (ctx.config.crossChainArb?.enabled) {
    void (async () => {
      ctx.logger.info({}, "Cross-chain scanner background loop started");
      while (ctx.isRunning) {
        try {
          const pools = hasuraPoolsCache ?? ctx.getPools();
          if (pools.length > 0) {
            const polygonPoolStates: PolygonPoolState[] = pools.map((p) => ({
              address: p.address,
              protocol: p.protocol,
              token0: p.token0,
              token1: p.token1,
            }));
            const crossChainRoutes = await ctx.crossChainScanner!.findProfitableRoutes(polygonPoolStates, ctx.stateCache, []);
            for (const route of crossChainRoutes) {
              if (!ctx.isRunning) break;
              ctx.logger.info({ route }, "Cross-chain arb opportunity found");
              const success = await ctx.solverBot!.executeCrossChainArb(route);
              ctx.logger.info({ routeKey: route.flashPool, success }, "Cross-chain arb executed");
            }
          }
        } catch (err) {
          ctx.logger.error({ err }, "Cross-chain arb loop error");
        }
        await sleep(LF_INTERVAL);
      }
    })();
  }

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
      }

      // Reorg safety check on every cycle
      if (ctx.reorgDetector && lastSimulationBlock > 0) {
        const reorged = await ctx.reorgDetector.checkReorg();
        if (reorged.size > 0) {
          ctx.logger.warn({ reorgedBlocks: [...reorged].join(",") }, "Reorg detected — forcing state refresh");
          const affectedPools = new Set<string>();
          for (const cycle of cachedCycles) {
            for (const edge of cycle.edges) {
              affectedPools.add(edge.poolAddress.toLowerCase());
            }
          }
          // Force re-enumeration on reorg
          lastRefreshTime = 0;
          ctx.reorgDetector.clearReorged();
        }
      }

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

      if (lastPoolsCount !== pools.length) {
        cachedGraph = deps.buildGraph(pools, stateCache);
        lastPoolsCount = pools.length;
        ctx.graphUpdater?.resetRebuildCounter();
      } else if (ctx.graphUpdater && cachedGraph) {
        // Incremental update: apply new pool states without full rebuild
        for (const pool of pools) {
          const addr = pool.address.toLowerCase();
          const state = stateCache.get(addr);
          if (state) {
            ctx.graphUpdater.applyPoolStateUpdate(cachedGraph, addr, state);
          }
        }
      }

      const shouldReEnumerate = now - lastRefreshTime >= LF_INTERVAL;
      const shouldFullRebuild = ctx.graphUpdater?.shouldFullRebuild() ?? true;

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
        const poolCycles = pools.map((p) => ({ edges: [{ poolAddress: p.address }] }) as any);
        await fetchMissingPoolState(ctx.publicClient, stateCache, pools, poolCycles, true);

        // Re-calculate MATIC rates for all tokens
        cachedRates = computeMaticRates(pools, stateCache, ctx.logger, {
          minLiquidityV3: ctx.config.execution.minLiquidityV3Rate,
        });

        // Track that we just did a full refresh to avoid redundant pre-fetch below
        lastFullRefreshTime = now;
        }

        if (shouldReEnumerate || !cachedGraph) {
          bus?.emit({ type: "pipeline_stage", stage: "ENUMERATING" });
          const filteredPools = pools.filter((p) => {
            const protocol = p.protocol.toLowerCase();
            const addr = p.address.toLowerCase();
            if (protocol.includes("v3") || protocol.includes("v4") || protocol.includes("elastic")) {
              const state = stateCache.get(addr);
              if (!state) return false; // Exclude if no state
              const liq = BigInt(state.liquidity as any || 0n);
              if (liq < ctx.config.execution.minLiquidityV3Rate) {
                if (addr === "0x56ff3a6fa5476c5fd28af7616d8bb35e50a47a81") {
                  ctx.logger.debug({ addr, liq: liq.toString(), floor: ctx.config.execution.minLiquidityV3Rate.toString() }, "Specifically filtered 0x56ff");
                }
                return false;
              }
            }
            return true;
          });

          ctx.logger.info({ 
            total: pools.length, 
            filtered: filteredPools.length, 
            removed: pools.length - filteredPools.length 
          }, "Pools filtered for graph building");

          // Rebuild graph every time we re-enumerate to ensure filters are applied
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
          await fetchMissingPoolState(ctx.publicClient, stateCache, pools, currentCycles);
          // Force rate recalculation after state fetch
          cachedRates = computeMaticRates(pools, stateCache, ctx.logger, {
            minLiquidityV3: ctx.config.execution.minLiquidityV3Rate,
          });
          if (!cachedMetas) {
            cachedMetas = await deps.fetchTokenMetasFromHasura(ctx.config.hasuraUrl, ctx.config.hasuraSecret);
          }
        }

        const gasSnapshot = ctx.gasOracle.getSnapshot();
        if (!gasSnapshot) {
        ctx.logger.debug({}, "Waiting for gas oracle snapshot");
        bus?.emit({ type: "pipeline_stage", stage: "IDLE" });
        await sleep(100);
        continue;
        }

        if (!cachedRates) {
        cachedRates = computeMaticRates(pools, stateCache, ctx.logger, {
          minLiquidityV3: ctx.config.execution.minLiquidityV3Rate,
        });
        }
        const tokenToMaticRates = cachedRates!;

        // Filter out quarantined routes before simulation to avoid repetitive noise
        const filteredCycles = currentCycles.filter((cycle) => {
        const routeKey = deps.routeKeyFromEdges(cycle.edges, cycle.startToken);
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

        const options: PipelineOptions = {
        minProfitMaticWei: ctx.config.execution.minProfitWei,
        gasPriceWei: gasSnapshot.gasPrice,
        tokenToMaticRates,
        tokenMetas: cachedMetas ?? undefined,
        slippageBps: ctx.config.execution.slippageBps,
        revertRiskBps: ctx.config.execution.revertRiskBps,
        flashLoanSource: ctx.config.execution.flashLoanSource === "AAVE_V3" ? FlashLoanSource.AAVE_V3 : FlashLoanSource.BALANCER,
        ternarySearchIterations: ctx.config.routing.ternarySearchIterations,
        maxPriceImpactThreshold: ctx.config.routing.maxPriceImpactThreshold,
        concurrency: ctx.config.routing.concurrency,
        roiSafetyCap: ctx.config.execution.roiSafetyCap,
        logger: ctx.logger,
        onProgress: (current, total, profitable) => {      if (current % 10 === 0 || current === total) {
        bus?.emit({ type: "simulation_progress", current, total, profitable });
      }
    },
  };

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

            const routeKey = deps.routeKeyFromEdges(profitable.cycle.edges, profitable.cycle.startToken);

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
              const candidate = deps.buildExecutionCandidate(
                profitable,
                { executorAddress, fromAddress: executorAddress },
                {
                  slippageBps: Number(options.slippageBps ?? 50n),
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
                        pools: profitable.cycle.edges.map(e => e.poolAddress),
                        protocols: profitable.cycle.edges.map(e => e.protocol)
                      }
                    },
                    "Dry-run against pending state failed, skipping",
                  );
                  ctx.executionService.getQuarantineManager().add(routeKey, dryRun.revertReason || dryRun.error);
                  continue;
                }              }

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
                  const tracked = ctx.executionService.tracker.getRecentRecords(10).find(e => e.txHash === execResult.txHash);
                  const profitWei = tracked ? tracked.profit : candidates.find(c => c.routeKey === routeKey)?.profitable.assessment.netProfitAfterGas;

                  bus?.emit({ type: "execution_result", routeKey, success: true, txHash: execResult.txHash, profitWei });
                } else if (execResult.error === "reverted") {
                  ctx.metrics.executionReverts++;
                  ctx.logger.warn({ routeKey }, "Transaction reverted on chain");
                  bus?.emit({ type: "execution_result", routeKey, success: false, error: "reverted" });
                } else {
                  ctx.metrics.executionsFailed++;
                  ctx.logger.warn({ error: execResult.error, routeKey }, "Execution failed");
                  ctx.metrics.totalErrors++;
                  ctx.metrics.lastErrorTime = Date.now();
                  ctx.metrics.lastErrorMessage = "Execution failed: " + (execResult.error ?? "");
                  bus?.emit({ type: "execution_result", routeKey, success: false, error: execResult.error });
                }
              }
            }
          }
        }
      }

      const elapsed = Date.now() - startTime;
      ctx.metrics.lastCycleDurationMs = elapsed;
      const trackerSummary = ctx.executionService.tracker.summary;
      ctx.metrics.executionReverts = trackerSummary.totalReverts;
      ctx.metrics.trackedRoutes = trackerSummary.trackedRoutes;
      bus?.emit({ type: "heartbeat", elapsedMs: elapsed, cycles: ctx.metrics.cycles, totalErrors: ctx.metrics.totalErrors });
      const payload = buildStatusPayload(ctx.metrics, gasSnapshot.gasPrice, pools.length);
      await writeStatusFile(ctx.config.paths.dataDir, payload).catch(() => {});

      // Track current block for reorg safety
      if (ctx.reorgDetector && ctx.publicClient) {
        try {
          const latest = await ctx.publicClient.getBlock({ blockTag: "latest" });
          if (latest.number && latest.hash) {
            await ctx.reorgDetector.trackBlock(Number(latest.number), latest.hash);
            lastSimulationBlock = Number(latest.number);
          }
        } catch {
          /* best effort */
        }
      }

      const waitMs = Math.max(50, HF_INTERVAL - elapsed);
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
