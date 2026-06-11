import type { RuntimeContext } from "./boot.ts";
import type { PassLoopDeps } from "./loop.ts";
import type { PassLoopState } from "./pass_state.ts";
import type { EventBus } from "../tui/events.ts";
import type { FoundCycle, PipelineOptions, PipelineResult, SwapEdge } from "../pipeline/index.ts";
import { FlashLoanSource } from "../core/types/execution.ts";
import { groupCompatibleCandidates, type CandidateExecution } from "../services/execution/service.ts";
import type { RouteStateCache } from "../core/types/route.ts";
import { buildStatusPayload, writeStatusFile } from "./status_writer.ts";
import { privateKeyToAccount } from "viem/accounts";

const HF_INTERVAL = 200;
const INDEXER_LAG_THRESHOLD_BLOCKS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runHfTick(
  ctx: RuntimeContext,
  state: PassLoopState,
  stateCache: RouteStateCache,
  deps: PassLoopDeps,
  bus?: EventBus,
): Promise<{ elapsed: number }> {
  const startTime = Date.now();
  const now = startTime;
  const currentPassTraceId = state.lastMempoolTraceId;
  state.lastMempoolTraceId = undefined;

  const currentCycles = state.cachedCycles;

  // === INDEXER LAG DETECTION ===
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
    return { elapsed: Date.now() - startTime };
  }

  bus?.emit({ type: "gas_snapshot", gasPrice: gasSnapshot.gasPrice });

  // Build non-quarantined cycle indices
  const cycleIndices: number[] = [];
  const qm = ctx.executionService.getQuarantineManager();
  for (let ci = 0; ci < currentCycles.length; ci++) {
    const cycle = currentCycles[ci];
    const routeKey = cycle.id ?? deps.routeKeyFromEdges(cycle.edges);
    if (!qm.isQuarantined(routeKey)) {
      cycleIndices.push(ci);
    }
  }

  if (cycleIndices.length === 0) {
    bus?.emit({ type: "pipeline_stage", stage: "IDLE" });
    await sleep(HF_INTERVAL);
    return { elapsed: Date.now() - startTime };
  }

  // Mempool-aware dry run
  if (ctx.dryRunner) {
    await ctx.dryRunner.fetchPendingState();
  }

  bus?.emit({ type: "pipeline_stage", stage: "SIMULATING" });

  const isDegraded = currentIndexerLag > INDEXER_LAG_THRESHOLD_BLOCKS;
  const baseConc = ctx.config.routing.concurrency ?? 50;
  let effectiveConcurrency = isDegraded ? Math.max(10, Math.floor(baseConc * 0.4)) : baseConc;
  const rpsConc = ctx.config.rpc.chainstackRps ?? 250;
  if (rpsConc <= 250) {
    effectiveConcurrency = Math.max(4, Math.floor(effectiveConcurrency * 0.5));
  }
  const effectiveMinProfit = isDegraded
    ? ctx.config.execution.minProfitWei * 2n
    : ctx.config.execution.minProfitWei;

  const options: PipelineOptions = {
    minProfitMaticWei: effectiveMinProfit,
    gasPriceWei: gasSnapshot.gasPrice,
    tokenToMaticRates: state.tokenToMaticRates,
    tokenMetas: state.cachedMetas ?? undefined,
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

  // Focus on rate-covered cycles
  const rateSafeCycles: FoundCycle[] = [];
  for (const ci of cycleIndices) {
    const cycle = currentCycles[ci];
    const startRate = state.tokenToMaticRates.get(cycle.startToken.toLowerCase()) ?? 0n;
    if (startRate > 0n) rateSafeCycles.push(cycle);
  }

  if (rateSafeCycles.length === 0 && cycleIndices.length > 0) {
    ctx.logger.debug(
      { totalFiltered: cycleIndices.length, rates: state.tokenToMaticRates.size },
      "No rate-covered cycles this pass (coverage still growing)",
    );
  }

  const simStartTime = Date.now();
  const result = await deps.evaluatePipeline(rateSafeCycles, stateCache, options, ctx.pendingStateOverlay);
  const simElapsed = Date.now() - simStartTime;

  ctx.metrics.opportunitiesFound += result.profitableCount;

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
    ratesCovered: state.tokenToMaticRates.size,
    cacheSize: stateCache.size,
    rateSafeCycles: rateSafeCycles.length,
    totalCycles: cycleIndices.length,
  });

  if (result.attempted > 0) {
    const tier = ctx.tierManager.getCurrent();
    if (result.profitable.length > 0 && !ctx.tierManager.shouldExecute()) {
      ctx.logger.debug({ tier, count: result.profitable.length }, "Execution suppressed by degradation tier");
    } else if (result.profitable.length > 0) {
      await buildAndExecuteCandidates(
        ctx, state, deps, result.profitable, currentPassTraceId, options, now, bus,
      );
    }
  }

  const elapsed = Date.now() - startTime;
  ctx.metrics.lastCycleDurationMs = elapsed;

  // Track heap growth every 1000 cycles when debug logging is enabled
  const { cycles } = ctx.metrics;
  if (ctx.config.observability.logLevel === "debug" && cycles % 1000 === 0) {
    const mem = process.memoryUsage();
    const heapMb = Math.round(mem.heapUsed / 1024 / 1024);
    ctx.logger.debug?.({ heapMb, rssMb: Math.round(mem.rss / 1024 / 1024) }, "Memory snapshot");
  }

  // Minimal HF budget instrumentation
  const HF_BUDGET_MS = 160;
  if (elapsed > HF_BUDGET_MS) {
    const timings = ctx.config.observability.logLevel === "debug" ? {} : undefined;
    ctx.logger.debug(
      { elapsed, budget: HF_BUDGET_MS, cycles, ...(timings ? { timings } : {}) },
      "HF cycle exceeded budget — possible hot-path regression (reorg, heavy RPC, or expensive simulation)",
    );
  }
  if (!ctx.metrics.maxHotPathDurationMs || elapsed > ctx.metrics.maxHotPathDurationMs) {
    ctx.metrics.maxHotPathDurationMs = elapsed;
  }

  const trackerSummary = ctx.executionService.tracker.summary;
  ctx.metrics.executionReverts = trackerSummary.totalReverts;
  ctx.metrics.trackedRoutes = trackerSummary.trackedRoutes;

  const maticPriceUsd = computeMaticPriceUsd(state.tokenToMaticRates);

  const isRpcConnected = ctx.rpcCircuit.isHealthy();
  const isHasuraConnected = ctx.hasuraCircuit.isHealthy();
  const isWsConnected = !!ctx.wsSubscriber && ctx.wsSubscriber.isConnected();

  const trackerSummary2 = ctx.executionService.tracker.summary;
  const successRateVal =
    trackerSummary2.totalAttempts > 0 ? Math.round((trackerSummary2.totalSuccesses / trackerSummary2.totalAttempts) * 100) : 0;

  bus?.emit({
    type: "heartbeat",
    elapsedMs: elapsed,
    cycles,
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
  bus?.emit({ type: "connection_status", subsystem: "rpc", status: isRpcConnected ? "connected" : "disconnected" });
  bus?.emit({ type: "connection_status", subsystem: "hasura", status: isHasuraConnected ? "connected" : "disconnected" });
  bus?.emit({ type: "connection_status", subsystem: "ws", status: isWsConnected ? "connected" : "disconnected" });
  const hiStatus = ctx.hyperIndexMonitor ? ctx.hyperIndexMonitor.getLastStatus() : undefined;

  const payload = buildStatusPayload(
    ctx.metrics,
    gasSnapshot.gasPrice,
    state.hasuraPoolsCache?.length ?? 0,
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
  const statusChanged =
    cycles % 5 === 0 ||
    ctx.metrics.executionsAttempted > 0 ||
    ctx.metrics.totalErrors > 0;
  if (now - state.lastStatusWriteTime > (statusChanged ? 1000 : 5000)) {
    state.lastStatusWriteTime = now;
    writeStatusFile(ctx.config.paths.dataDir, payload).catch((err) => {
      ctx.logger.debug?.({ err }, "Failed to write status file");
    });
  }

  return { elapsed };
}

export function computeMaticPriceUsd(tokenToMaticRates: Map<string, bigint>): number {
  let maticPriceUsd = 0.7;
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
  return maticPriceUsd;
}

async function buildAndExecuteCandidates(
  ctx: RuntimeContext,
  state: PassLoopState,
  deps: PassLoopDeps,
  profitable: PipelineResult["profitable"],
  currentPassTraceId: string | undefined,
  options: PipelineOptions,
  now: number,
  bus?: EventBus,
): Promise<void> {
  const { executorAddress } = ctx.config.execution;
  const operatorAccount = privateKeyToAccount(ctx.config.execution.privateKey as `0x${string}`);
  const operatorAddress = operatorAccount.address;

  const candidates: { candidate: CandidateExecution; profitable: (typeof profitable)[number]; routeKey: string }[] = [];

  const candidatePromises = profitable.map(async (profitableItem) => {
    if (!ctx.isRunning) return null;

    const routeKey = profitableItem.cycle.id ?? deps.routeKeyFromEdges(profitableItem.cycle.edges);

    const lastSubmit = state.recentRouteTimestamps.get(routeKey);
    const lowInfraForCooldown = (ctx.config.rpc.chainstackRps ?? 250) <= 250;
    const ROUTE_COOLDOWN_MS = lowInfraForCooldown ? 12000 : 5000;
    if (lastSubmit && now - lastSubmit < ROUTE_COOLDOWN_MS) {
      ctx.logger.debug({ routeKey, lastSubmit, now }, "Route recently submitted, skipping cooldown");
      return null;
    }
    state.recentRouteTimestamps.set(routeKey, now);

    const path = profitableItem.result.tokenPath.map((t) => t.slice(0, 6)).join(" -> ");
    const roi = Number(profitableItem.assessment.roi);
    const isNearMiss = roi > 950_000 && roi < 1_000_000;

    if (isNearMiss) {
      ctx.logger.debug(
        {
          routeKey,
          roi,
          profit: profitableItem.assessment.netProfitAfterGas.toString(),
          path: profitableItem.result.tokenPath.join(" -> "),
        },
        "Near-miss opportunity identified",
      );
    }

    if (!profitableItem.result.profitable) return null;

    deps.instrumenter.captureTrace(routeKey, profitableItem.result, ctx.stateCache);

    bus?.emit({
      type: "opportunity_found",
      routeKey,
      profitWei: profitableItem.assessment.netProfitAfterGasMaticWei,
      path,
      roi: profitableItem.assessment.roi,
    });

    try {
      const candidate = deps.buildExecutionCandidate(
        profitableItem,
        { executorAddress, fromAddress: executorAddress },
        {
          slippageBps: Number(options.slippageBps ?? 50n),
          flashLoanSource: options.flashLoanSource === FlashLoanSource.AAVE_V3 ? "AAVE_V3" : "BALANCER",
          stateCache: ctx.stateCache,
        },
        currentPassTraceId,
      );

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
                roi: profitableItem.assessment.roi,
                profit: profitableItem.assessment.netProfitAfterGas.toString(),
                pools: profitableItem.cycle.edges.map((e) => e.poolAddress),
                protocols: profitableItem.cycle.edges.map((e) => e.protocol),
              },
            },
            "Dry-run against pending state failed, skipping",
          );
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
          } catch (dumpErr) {
            ctx.logger.warn?.({ err: dumpErr, routeKey }, "Failed to dump failing calldata");
          }
          ctx.executionService.getQuarantineManager().add(routeKey, dryRun.revertReason || dryRun.error);
          return null;
        }
      }

      return { candidate, profitable: profitableItem, routeKey };
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

          const tracked = ctx.executionService.tracker.getRecentRecords(10).find((e) => e.txHash === execResult.txHash);
          const cand = candidates.find((c) => c.routeKey === routeKey);
          let profitWei = 0n;
          if (cand) {
            const startRate = state.tokenToMaticRates.get(cand.profitable.cycle.startToken.toLowerCase()) ?? 0n;
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
