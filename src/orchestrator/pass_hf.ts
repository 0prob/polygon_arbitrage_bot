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
import {
  logHfPassMetrics,
  summarizeCycleRateCoverage,
} from "../infra/observability/metrics.ts";
import { resolveInfraProfile, scaledConcurrency, type InfraProfile } from "../config/infra_profile.ts";
import { buildHopBalancedWindow, hopSimBucket } from "../pipeline/finder.ts";
import { getHfSnapshot, type HfReadSnapshot } from "./hf_snapshot.ts";
import { debugBreak, debugLog, DebugSites } from "../infra/debug/session.ts";
import { mapWithConcurrency } from "../core/utils/concurrency.ts";
const INDEXER_LAG_THRESHOLD_BLOCKS = 5000;
const ORACLE_FALLBACK_CONCURRENCY = 8;
const ORACLE_FALLBACK_MAX_PER_TICK = 24;

async function resolveOracleFallbackRates(
  ctx: RuntimeContext,
  snap: HfReadSnapshot,
  tokenKeys: string[],
  state: PassLoopState,
): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  if (!ctx.priceOracle || ctx.config.oracle.enabled === false) return out;

  if (!state.oracleRateCache) state.oracleRateCache = new Map();

  const missing: string[] = [];
  for (const raw of new Set(tokenKeys.map((t) => t.toLowerCase()))) {
    if ((snap.tokenToMaticRates.get(raw) ?? 0n) > 0n) continue;
    const cached = state.oracleRateCache.get(raw);
    if (cached !== undefined) {
      if (cached > 0n) out.set(raw, cached);
      continue;
    }
    missing.push(raw);
  }

  const batch = missing.slice(0, ORACLE_FALLBACK_MAX_PER_TICK);
  const oracleStart = Date.now();
  for (let i = 0; i < batch.length; i += ORACLE_FALLBACK_CONCURRENCY) {
    const chunk = batch.slice(i, i + ORACLE_FALLBACK_CONCURRENCY);
    await Promise.all(
      chunk.map(async (tokenKey) => {
        try {
          const { rate } = await ctx.priceOracle!.getTokenToMaticRate(tokenKey, 0n, ctx.publicClient);
          state.oracleRateCache!.set(tokenKey, rate);
          if (rate > 0n) out.set(tokenKey, rate);
        } catch {
          state.oracleRateCache!.set(tokenKey, 0n);
        }
      }),
    );
  }
  if (batch.length > 0) {
    debugLog(
      "pass_hf.ts:oracle",
      "oracle fallback batch",
      { requested: missing.length, fetched: batch.length, elapsedMs: Date.now() - oracleStart },
      DebugSites.HF_TICK,
    );
  }
  return out;
}

function rateForToken(
  tokenKey: string,
  snap: HfReadSnapshot,
  oracleFallback: Map<string, bigint>,
  oracleCache?: Map<string, bigint>,
): bigint {
  const fromSnap = snap.tokenToMaticRates.get(tokenKey) ?? 0n;
  if (fromSnap > 0n) return fromSnap;
  const fromTick = oracleFallback.get(tokenKey) ?? 0n;
  if (fromTick > 0n) return fromTick;
  return oracleCache?.get(tokenKey) ?? 0n;
}

/** Prefer shorter hop counts — 5-hop cycles dominate enumeration but rarely clear gas+fees. */
function selectCyclesForSim(cycles: FoundCycle[], cap: number): FoundCycle[] {
  if (cycles.length <= cap) return cycles;
  const byHop: FoundCycle[][] = [[], [], [], []];
  for (let i = 0; i < cycles.length; i++) {
    byHop[hopSimBucket(cycles[i].hopCount)].push(cycles[i]);
  }
  const selected: FoundCycle[] = [];
  for (let b = 0; b < byHop.length; b++) {
    const tier = byHop[b];
    for (let i = 0; i < tier.length && selected.length < cap; i++) {
      selected.push(tier[i]);
    }
    if (selected.length >= cap) break;
  }
  return selected;
}

/** Rotate through the full cycle set so HF does not resimulate the same cap every tick. */
function selectCyclesForSimRotating(cycles: FoundCycle[], cap: number, offset: number): { selected: FoundCycle[]; nextOffset: number } {
  if (cycles.length <= cap) {
    return { selected: selectCyclesForSim(cycles, cap), nextOffset: 0 };
  }
  const windowSize = Math.min(cycles.length, cap * 3);
  const window = buildHopBalancedWindow(cycles, windowSize, offset);
  return {
    selected: selectCyclesForSim(window, cap),
    nextOffset: (offset + cap) % cycles.length,
  };
}

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
  const snap = getHfSnapshot(state);
  // Sampled — avoid flooding debug ingest / stepping into pino→stream on every HF tick
  if (state.hfTickCount === undefined) state.hfTickCount = 0;
  state.hfTickCount++;
  if (state.hfTickCount === 1 || state.hfTickCount % 200 === 0) {
    debugLog("pass_hf.ts:tick", "HF tick start", { cachedCycles: snap.cachedCycles.length, tick: state.hfTickCount }, DebugSites.HF_TICK);
  }
  const currentPassTraceId = state.lastMempoolTraceId;
  state.lastMempoolTraceId = undefined;

  const currentCycles = snap.cachedCycles;
  const infra = resolveInfraProfile(ctx.config);

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
    return { elapsed: Date.now() - startTime };
  }

  bus?.emit({ type: "pipeline_stage", stage: "SIMULATING" });

  const isDegraded = currentIndexerLag > INDEXER_LAG_THRESHOLD_BLOCKS;
  const baseConc = ctx.config.routing.concurrency ?? 50;
  const effectiveConcurrency = scaledConcurrency(baseConc, infra, isDegraded);
  const effectiveMinProfit = isDegraded
    ? ctx.config.execution.minProfitWei * 2n
    : ctx.config.execution.minProfitWei;

  if (isDegraded) {
    ctx.logger.debug(
      { effectiveConcurrency, effectiveMinProfit: effectiveMinProfit.toString() },
      "Running in indexer-lag degraded mode",
    );
  }

  // Rate-covered cycles using pool-graph + cached oracle only (no RPC on hot path yet)
  const rateSafeCycles: FoundCycle[] = [];
  for (const ci of cycleIndices) {
    const cycle = currentCycles[ci];
    const tokenKey = cycle.startToken.toLowerCase();
    const startRate = rateForToken(tokenKey, snap, new Map(), state.oracleRateCache);
    if (startRate > 0n) rateSafeCycles.push(cycle);
  }

  if (rateSafeCycles.length === 0 && cycleIndices.length > 0) {
    ctx.logger.debug(
      { totalFiltered: cycleIndices.length, rates: snap.tokenToMaticRates.size },
      "No rate-covered cycles this pass (coverage still growing)",
    );
  }

  const simCapBase = infra.maxSimCycles;
  const lastSimMs = state.lastHfSimMs ?? 0;
  const simCap =
    lastSimMs > infra.hfBudgetMs * 2
      ? Math.max(100, Math.floor(simCapBase * (infra.hfBudgetMs / lastSimMs)))
      : simCapBase;
  let cyclesToSim: FoundCycle[];
  if (rateSafeCycles.length > simCap) {
    const rotated = selectCyclesForSimRotating(rateSafeCycles, simCap, state.hfSimOffset);
    cyclesToSim = rotated.selected;
    state.hfSimOffset = rotated.nextOffset;
  } else {
    cyclesToSim = rateSafeCycles;
    state.hfSimOffset = 0;
  }

  // Oracle fallback only for the sim batch — capped per tick to protect HF budget
  const oracleFallbackRates = await resolveOracleFallbackRates(
    ctx,
    snap,
    cyclesToSim.map((c) => c.startToken.toLowerCase()),
    state,
  );

  const simTokenRates = new Map(snap.tokenToMaticRates);
  for (const [k, v] of oracleFallbackRates) simTokenRates.set(k, v);
  for (const [k, v] of state.oracleRateCache ?? []) {
    if (v > 0n && !simTokenRates.has(k)) simTokenRates.set(k, v);
  }

  const options: PipelineOptions = {
    minProfitMaticWei: effectiveMinProfit,
    gasPriceWei: gasSnapshot.gasPrice,
    tokenToMaticRates: simTokenRates,
    tokenMetas: snap.cachedMetas ?? undefined,
    slippageBps: ctx.config.execution.slippageBps,
    revertRiskBps: ctx.config.execution.revertRiskBps,
    flashLoanSource: ctx.config.execution.flashLoanSource === "AAVE_V3" ? FlashLoanSource.AAVE_V3 : FlashLoanSource.BALANCER,
    ternarySearchIterations: ctx.config.routing.ternarySearchIterations,
    maxPriceImpactThreshold: ctx.config.routing.maxPriceImpactThreshold,
    v3ShallowMaxImpactBps: ctx.config.routing.v3ShallowMaxImpactBps,
    concurrency: effectiveConcurrency,
    simBatchSize: infra.simBatchSize,
    roiSafetyCap: ctx.config.execution.roiSafetyCap,
    pendingOverrideStore: ctx.pendingOverrideStore,
    maxDurationMs: Math.max(80, infra.hfBudgetMs - 20),
    logger: ctx.logger,
    onProgress: (current, total, profitable) => {
      if (current % 10 === 0 || current === total) {
        bus?.emit({ type: "simulation_progress", current, total, profitable });
      }
    },
  };

  const simSkipped = rateSafeCycles.length - cyclesToSim.length;
  if (simSkipped > 0) {
    ctx.logger.debug(
      { total: rateSafeCycles.length, simCap, skipped: simSkipped },
      "Capped simulation batch to top-scored cycles",
    );
  }
  const simHopDist: Record<number, number> = {};
  for (const c of cyclesToSim) {
    simHopDist[c.hopCount] = (simHopDist[c.hopCount] ?? 0) + 1;
  }

  const simStartTime = Date.now();
  const result = await deps.evaluatePipeline(cyclesToSim, stateCache, options, ctx.pendingStateOverlay);
  const simElapsed = Date.now() - simStartTime;
  state.lastHfSimMs = simElapsed;

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
    ratesCovered: snap.tokenToMaticRates.size,
    cacheSize: stateCache.size,
    rateSafeCycles: rateSafeCycles.length,
    totalCycles: cycleIndices.length,
  });

  if (result.attempted > 0) {
    const tier = ctx.tierManager.getCurrent();
    if (result.profitable.length > 0 && !ctx.tierManager.shouldExecute()) {
      ctx.logger.debug({ tier, count: result.profitable.length }, "Execution suppressed by degradation tier");
    } else if (result.profitable.length > 0) {
      debugBreak(DebugSites.PROFITABLE_FOUND, {
        count: result.profitable.length,
        topProfit: result.profitable[0]?.assessment.netProfitAfterGas.toString(),
      });
      await buildAndExecuteCandidates(
        ctx, state, snap, deps, result.profitable, currentPassTraceId, options, now, infra, bus,
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

  const HF_BUDGET_MS = infra.hfBudgetMs;
  if (elapsed > HF_BUDGET_MS) {
    ctx.logger.debug(
      {
        elapsed,
        simMs: simElapsed,
        budget: HF_BUDGET_MS,
        cycles,
        snapGeneration: snap.generation,
        lfEnumInFlight: snap.lfEnumerationInFlight,
        infraTier: infra.tier,
      },
      "HF cycle exceeded budget — possible hot-path regression (reorg, heavy RPC, or expensive simulation)",
    );
  }
  if (!ctx.metrics.maxHotPathDurationMs || elapsed > ctx.metrics.maxHotPathDurationMs) {
    ctx.metrics.maxHotPathDurationMs = elapsed;
  }

  const trackerSummary = ctx.executionService.tracker.summary;
  ctx.metrics.executionReverts = trackerSummary.totalReverts;
  ctx.metrics.trackedRoutes = trackerSummary.trackedRoutes;

  const maticPriceUsd = snap.maticPriceUsd;

  const isRpcConnected = ctx.rpcCircuit.isHealthy();
  const isHasuraConnected = ctx.hasuraCircuit.isHealthy();
  const isWsConnected = !!ctx.wsSubscriber && ctx.wsSubscriber.isConnected();

  const successRateVal =
    trackerSummary.totalAttempts > 0 ? Math.round((trackerSummary.totalSuccesses / trackerSummary.totalAttempts) * 100) : 0;

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
    trackedRoutes: trackerSummary.trackedRoutes,
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

  logHfPassMetrics(ctx.logger, {
    elapsedMs: elapsed,
    simMs: simElapsed,
    cyclesTotal: cycleIndices.length,
    rateSafe: rateSafeCycles.length,
    simCap,
    simSkipped,
    simHopDist,
    ratesCount: snap.tokenToMaticRates.size,
    attempted: result.attempted,
    simulated: result.simulated,
    profitable: result.profitableCount,
    prunedMissing: result.prunedMissingState,
    prunedNoGross: result.prunedNoGrossProfit,
    prunedFinalCheck: result.prunedFinalCheckFailed,
    nearMiss: result.nearMissCount ?? 0,
    maxGrossMilliMatic:
      result.maxGrossProfitMatic !== undefined ? Number(result.maxGrossProfitMatic / 10n ** 15n) : 0,
    gasPriceGwei: Number(gasSnapshot.gasPrice) / 1e9,
    indexerLag: currentIndexerLag,
    rpcOk: isRpcConnected,
    hasuraOk: isHasuraConnected,
    wsOk: isWsConnected,
    tier: ctx.tierManager.getCurrent(),
    degraded: isDegraded,
    quarantinedRoutes: qm.size,
    tierAllowsExecute: ctx.tierManager.shouldExecute(),
    cycleRates: summarizeCycleRateCoverage(currentCycles, snap.tokenToMaticRates, simCap),
    lfEnumInFlight: snap.lfEnumerationInFlight,
    snapGeneration: snap.generation,
  });

  return { elapsed };
}

async function buildAndExecuteCandidates(
  ctx: RuntimeContext,
  state: PassLoopState,
  snap: HfReadSnapshot,
  deps: PassLoopDeps,
  profitable: PipelineResult["profitable"],
  currentPassTraceId: string | undefined,
  options: PipelineOptions,
  now: number,
  infra: InfraProfile,
  bus?: EventBus,
): Promise<void> {
  const { executorAddress } = ctx.config.execution;
  const operatorAccount = privateKeyToAccount(ctx.config.execution.privateKey as `0x${string}`);
  const operatorAddress = operatorAccount.address;

  const candidates: { candidate: CandidateExecution; profitable: (typeof profitable)[number]; routeKey: string }[] = [];

  const buildOneCandidate = async (profitableItem: (typeof profitable)[number]) => {
    if (!ctx.isRunning) return null;

    const routeKey = profitableItem.cycle.id ?? deps.routeKeyFromEdges(profitableItem.cycle.edges);

    const lastSubmit = state.recentRouteTimestamps.get(routeKey);
    const ROUTE_COOLDOWN_MS = infra.routeCooldownMs;
    if (lastSubmit && now - lastSubmit < ROUTE_COOLDOWN_MS) {
      ctx.logger.debug({ routeKey, lastSubmit, now }, "Route recently submitted, skipping cooldown");
      return null;
    }

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
        if (dryRun.gasUsed != null && dryRun.gasUsed > 0n) {
          candidate.gasLimit = (dryRun.gasUsed * 120n) / 100n + 1n;
        } else if (candidate.gasLimit == null && profitableItem.result.totalGas > 0) {
          candidate.gasLimit = BigInt(Math.ceil(profitableItem.result.totalGas * 1.2));
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
  };

  const resolvedCandidates = await mapWithConcurrency(profitable, infra.dryRunConcurrency, buildOneCandidate);
  for (const res of resolvedCandidates) {
    if (res) candidates.push(res);
  }

  if (ctx.config.ranking.mode === "statistical" && candidates.length > 1) {
    const { sortCandidatesByEv } = await import("../services/ranking/scorer.ts");
    const rankInputs = candidates.map((c) => ({
      routeKey: c.candidate.routeKey,
      gasLimit: c.candidate.gasLimit,
      gasPriceWei: options.gasPriceWei,
      expectedProfit: c.candidate.expectedProfit ?? c.profitable.assessment.netProfitAfterGasMaticWei,
    }));
    const sorted = sortCandidatesByEv(
      rankInputs,
      ctx.executionService.tracker,
      (k) => ctx.executionService.isQuarantined(k),
    );
    const order = new Map(sorted.map((c, i) => [c.routeKey, i]));
    candidates.sort((a, b) => (order.get(a.routeKey) ?? 0) - (order.get(b.routeKey) ?? 0));
  } else if (ctx.config.ranking.mode === "ml" && candidates.length > 1) {
    try {
      const { readFile } = await import("node:fs/promises");
      const raw = JSON.parse(await readFile(ctx.config.ranking.modelPath, "utf8"));
      const { loadRankingModel, scoreWithModel } = await import("../services/ranking/model.ts");
      const model = loadRankingModel(raw);
      if (model) {
        candidates.sort((a, b) => {
          const fa = {
            hopCount: a.profitable.cycle.hopCount,
            expectedProfit: Number(a.candidate.expectedProfit ?? 0n),
            gasLimit: Number(a.candidate.gasLimit ?? 0n),
          };
          const fb = {
            hopCount: b.profitable.cycle.hopCount,
            expectedProfit: Number(b.candidate.expectedProfit ?? 0n),
            gasLimit: Number(b.candidate.gasLimit ?? 0n),
          };
          return scoreWithModel(fb, model) - scoreWithModel(fa, model);
        });
      }
    } catch {
      // fall back to submission order when model unavailable
    }
  }

  for (const c of candidates) {
    void ctx.executionService.tracker.logOpportunityFeatures(
      `${ctx.config.paths.dataDir}/opportunity-features.ndjson`,
      {
        routeKey: c.routeKey,
        expectedProfit: c.candidate.expectedProfit?.toString(),
        gasLimit: c.candidate.gasLimit?.toString(),
        hopCount: c.profitable.cycle.hopCount,
        protocols: c.profitable.cycle.edges.map((e) => e.protocol),
      },
    );
  }

  if (candidates.length > 0) {
    bus?.emit({ type: "pipeline_stage", stage: "EXECUTING" });
    const candidateExecs = candidates.map((c) => c.candidate);
    const groups = groupCompatibleCandidates(candidateExecs);

    ctx.logger.info({ total: candidates.length, groups: groups.length }, "Executing opportunities in batches");

    const victimSignal = state.lastLargeSwapSignal;
    state.lastLargeSwapSignal = undefined;

    for (const group of groups) {
      if (!ctx.isRunning) break;
      ctx.metrics.executionsAttempted += group.length;

      const groupRouteKeys = group.map((c) => c.routeKey);
      ctx.logger.info({ groupSize: group.length, routeKeys: groupRouteKeys }, "Executing batch");

      for (const routeKey of groupRouteKeys) {
        bus?.emit({ type: "execution_submitted", routeKey });
      }

      for (const routeKey of groupRouteKeys) {
        const c = candidates.find((item) => item.routeKey === routeKey);
        if (!c) continue;
        bus?.emit({
          type: "execution_attempt",
          protocolPath: c.profitable.cycle.edges.map((e: SwapEdge) => e.protocol).join("→"),
          hopCount: c.profitable.cycle.hopCount,
          expectedProfit: c.profitable.assessment.netProfitAfterGasMaticWei,
          txHash: undefined,
        });
      }

      let results: Awaited<ReturnType<typeof ctx.executionService.execute>>[] = [];
      let runPublicExecute = true;

      if (ctx.config.mev?.enabled && victimSignal && group.length === 1) {
        const match = candidates.find((c) => c.routeKey === group[0].routeKey);
        if (match) {
          const { submitBackrunBundle, waitForBundledBackrunTx } = await import("../services/mev/backrun.ts");
          const backrun = await submitBackrunBundle(
            ctx,
            { victim: victimSignal, candidate: group[0], operatorAddress },
            victimSignal.rawTx ?? "",
          );
          if (backrun.submitted) {
            runPublicExecute = false;
            ctx.logger.info({ routeKey: group[0].routeKey, detail: backrun.detail }, "MEV bundle submitted — waiting for inclusion");
            const inclusion = await waitForBundledBackrunTx(
              ctx.publicClient,
              { victim: victimSignal, candidate: group[0], operatorAddress },
              victimSignal.txHash,
              ctx.config.mev.bundleWaitMs,
            );
            if (inclusion) {
              results = [await ctx.executionService.confirmExecution(group[0], inclusion.txHash)];
            } else if (ctx.config.mev.publicBackrunFallback) {
              runPublicExecute = true;
              ctx.logger.debug({ routeKey: group[0].routeKey }, "MEV bundle not included — public fallback");
            } else {
              results = [{ success: false, error: "mev_bundle_timeout" }];
            }
          } else if (backrun.mode !== "public_fallback") {
            ctx.logger.debug({ detail: backrun.detail }, "MEV backrun skipped");
          }
        }
      }

      if (runPublicExecute) {
        results =
          group.length === 1 ? [await ctx.executionService.execute(group[0])] : await ctx.executionService.batchExecute(group);
      }

      for (let i = 0; i < results.length; i++) {
        const execResult = results[i];
        const routeKey = groupRouteKeys[i];
        const execDetails = candidates.find((c) => c.routeKey === routeKey);
        const protocolPath = execDetails?.profitable.cycle.edges.map((e: SwapEdge) => e.protocol).join("→");
        const hopCount = execDetails?.profitable.cycle.hopCount;

        if (execResult.success) {
          ctx.metrics.executionsSuccessful++;
          state.recentRouteTimestamps.set(routeKey, now);
          ctx.logger.info({ txHash: execResult.txHash, routeKey }, "Transaction confirmed successfully");

          const tracked = ctx.executionService.tracker.getRecentRecords(10).find((e) => e.txHash === execResult.txHash);
          const cand = candidates.find((c) => c.routeKey === routeKey);
          let profitWei = 0n;
          if (cand) {
            const startRate = snap.tokenToMaticRates.get(cand.profitable.cycle.startToken.toLowerCase()) ?? 0n;
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
