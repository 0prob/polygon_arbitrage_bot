import type { RuntimeContext } from "./boot.ts";
import type { FoundCycle, PipelineOptions, ArbInstrumenter } from "../pipeline/index.ts";
import { buildGraph, findCycles, enumerateCycles, evaluatePipeline } from "../pipeline/index.ts";
import { discoverPoolsFromHasura, buildStateCacheFromGraphQL, fetchTokenMetasFromHasura } from "../infra/hypersync/hyperindex_graphql.ts";
import { buildExecutionCandidate } from "../services/execution/candidate.ts";
import type { EventBus } from "../tui/events.ts";
import { FlashLoanSource } from "../core/types/execution.ts";
import { groupCompatibleCandidates } from "../services/execution/service.ts";

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

export interface StageResult {
  cyclesFound: number;
  cyclesSimulated: number;
  candidatesBuilt: number;
  groupsExecuted: number;
}

export async function runPipeline(
  ctx: RuntimeContext,
  deps: PassLoopDeps,
  pools: any[],
  cachedCycles: FoundCycle[],
  cachedRates: Map<string, bigint> | null,
  cachedMetas: Map<string, { decimals: number }> | null,
  shouldReEnumerate: boolean,
  state: { cycles: FoundCycle[]; lastEnumeration: number },
  bus?: EventBus,
): Promise<StageResult> {
  const stateCache = ctx.stateCache;
  let cycles = cachedCycles;
  const result: StageResult = { cyclesFound: 0, cyclesSimulated: 0, candidatesBuilt: 0, groupsExecuted: 0 };

  if (shouldReEnumerate) {
    bus?.emit({ type: "pipeline_stage", stage: "ENUMERATING" });
    const filteredPools = pools.filter((p) => {
      const protocol = p.protocol.toLowerCase();
      const addr = p.address.toLowerCase();
      if (protocol.includes("v3") || protocol.includes("v4") || protocol.includes("elastic")) {
        const s = stateCache.get(addr);
        if (!s) return false;
        const liq = BigInt((s as any).liquidity || 0n);
        if (liq < ctx.config.execution.minLiquidityV3Rate) return false;
      }
      return true;
    });

    const graph = deps.buildGraph(filteredPools, stateCache);
    ctx.graphUpdater?.resetRebuildCounter();

    cycles = deps.enumerateCycles(graph, ctx.config.routing.maxHops, ctx.config.routing.enumerationMaxPaths, (key) =>
      ctx.executionService.tracker.getWinRate(key),
    );
    state.cycles = cycles;
    state.lastEnumeration = Date.now();
    result.cyclesFound = cycles.length;
  }

  if (cycles.length === 0) return result;

  // Filter quarantined routes
  const filteredCycles = cycles.filter((cycle) => {
    const routeKey = deps.routeKeyFromEdges(cycle.edges, cycle.startToken);
    return !ctx.executionService.isQuarantined(routeKey);
  });
  if (filteredCycles.length === 0) return result;

  // Ensure rates
  let tokenToMaticRates = cachedRates;
  if (!tokenToMaticRates) {
    const { computeMaticRates } = await import("../pipeline/index.ts");
    tokenToMaticRates = computeMaticRates(pools, stateCache, ctx.logger, {
      minLiquidityV3: ctx.config.execution.minLiquidityV3Rate,
    });
  }

  // Mempool dry-run pre-fetch
  if (ctx.dryRunner) {
    await ctx.dryRunner.fetchPendingState();
  }

  const gasSnapshot = ctx.gasOracle.getSnapshot();
  if (!gasSnapshot) return result;

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
    onProgress: (current: number, total: number, profitable: number) => {
      if (current % 10 === 0 || current === total) {
        bus?.emit({ type: "simulation_progress", current, total, profitable });
      }
    },
  };

  const simResult = await deps.evaluatePipeline(filteredCycles, stateCache, options);
  ctx.metrics.opportunitiesFound += simResult.profitableCount;
  result.cyclesSimulated = simResult.simulated;

  if (simResult.profitable.length > 0 && !ctx.tierManager.shouldExecute()) {
    ctx.logger.info({ tier: ctx.tierManager.getCurrent(), count: simResult.profitable.length }, "Execution suppressed by tier");
    return result;
  }

  if (simResult.profitable.length === 0) return result;

  // Build candidates
  const executorAddress = ctx.config.execution.executorAddress;
  const candidates: Array<{ candidate: any; routeKey: string }> = [];

  for (const profitable of simResult.profitable) {
    if (!ctx.isRunning) break;
    const routeKey = deps.routeKeyFromEdges(profitable.cycle.edges, profitable.cycle.startToken);

    const path = profitable.result.tokenPath.map((t: string) => t.slice(0, 6)).join(" -> ");
    bus?.emit({
      type: "opportunity_found",
      routeKey,
      profitWei: profitable.assessment.netProfitAfterGas,
      path,
      roi: profitable.assessment.roi,
    });

    deps.instrumenter.captureTrace(routeKey, profitable.result, stateCache);

    try {
      const candidate = deps.buildExecutionCandidate(
        profitable,
        { executorAddress, fromAddress: executorAddress },
        {
          slippageBps: Number(ctx.config.execution.slippageBps ?? 50n),
          flashLoanSource: ctx.config.execution.flashLoanSource === "AAVE_V3" ? "AAVE_V3" : "BALANCER",
          stateCache,
        },
      );

      if (ctx.dryRunner) {
        const dryRun = await ctx.dryRunner.dryRun(
          candidate,
          ctx.config.execution.privateKey.startsWith("0x")
            ? (ctx.config.execution.privateKey as `0x${string}`)
            : (`0x${ctx.config.execution.privateKey}` as `0x${string}`),
        );
        if (!dryRun.success) {
          ctx.executionService.getQuarantineManager().add(routeKey, dryRun.revertReason || dryRun.error);
          continue;
        }
      }

      candidates.push({ candidate, routeKey });
    } catch (err) {
      ctx.logger.error({ err, routeKey }, "Failed to build tx for cycle");
    }
  }

  if (candidates.length === 0) return result;

  // Execute
  bus?.emit({ type: "pipeline_stage", stage: "EXECUTING" });
  const candidateExecs = candidates.map((c) => c.candidate);
  const groups = groupCompatibleCandidates(candidateExecs);
  result.candidatesBuilt = candidates.length;
  result.groupsExecuted = groups.length;

  for (const group of groups) {
    if (!ctx.isRunning) break;
    ctx.metrics.executionsAttempted += group.length;
    const groupRouteKeys = group.map((c) => c.routeKey);

    for (const rk of groupRouteKeys) {
      bus?.emit({ type: "execution_submitted", routeKey: rk });
    }

    const results =
      group.length === 1
        ? [await ctx.executionService.execute(group[0])]
        : await ctx.executionService.batchExecute(group);

    for (let i = 0; i < results.length; i++) {
      const execResult = results[i];
      const routeKey = groupRouteKeys[i];

      if (execResult.success) {
        ctx.metrics.executionsSuccessful++;
        bus?.emit({ type: "execution_result", routeKey, success: true, txHash: execResult.txHash, profitWei: undefined });
      } else if (execResult.error === "reverted") {
        ctx.metrics.executionReverts++;
        bus?.emit({ type: "execution_result", routeKey, success: false, error: "reverted" });
      } else {
        ctx.metrics.executionsFailed++;
        ctx.logger.warn({ error: execResult.error, routeKey }, "Execution failed");
        bus?.emit({ type: "execution_result", routeKey, success: false, error: execResult.error });
      }
    }
  }

  return result;
}
