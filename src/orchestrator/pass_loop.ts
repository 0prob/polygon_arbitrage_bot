import type { RuntimeContext } from "./boot.ts";
import { buildGraph } from "../services/strategy/graph.ts";
import { enumerateCycles, routeKeyFromEdges } from "../services/strategy/finder.ts";
import { evaluatePipeline, type PipelineOptions } from "../services/strategy/pipeline.ts";
import { FlashLoanSource } from "../core/types/execution.ts";
import type { CandidateExecution } from "../services/execution/service.ts";
import type { BotState } from "../cli/tui.ts";

async function getGasPriceWei(ctx: RuntimeContext): Promise<bigint> {
  try {
    const block = await ctx.publicClient.getBlock({ blockTag: "latest" });
    const baseFee = block.baseFeePerGas ?? 30n * 10n ** 9n;
    return baseFee * 2n + 30n * 10n ** 9n;
  } catch {
    return 30n * 10n ** 9n;
  }
}

function weiToGwei(wei: bigint): string {
  return (Number(wei) / 1e9).toFixed(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runPassLoop(ctx: RuntimeContext, onStateUpdate?: (update: Partial<BotState>) => void): Promise<void> {
  const intervalMs = ctx.config.routing.cycleRefreshIntervalMs;

  await ctx.executionService.start();
  ctx.watcherService.start();
  await ctx.hydrationService.start();
  await ctx.discoveryService.start();
  await ctx.mempoolService.start();

  ctx.logger.info({ intervalMs }, "Pass loop started");

  let consecutiveErrors = 0;

  while (ctx.isRunning) {
    const startTime = Date.now();

    const state: Partial<BotState> = {
      status: "running",
      passCount: 0,
      lastUpdateMs: startTime,
    };

    try {
      const pools = ctx.getPools();
      state.stateCacheSize = pools.length;

import { withTimeout } from "../infra/rpc/retry.ts";
// ...
      if (pools.length === 0) {
        ctx.logger.info({}, "No pools found, triggering discovery");
        try {
          await withTimeout(
            Promise.all([
              ctx.discoveryService.discoverProtocol("balancer"),
              ctx.discoveryService.discoverProtocol("curve"),
            ]),
            30_000,
          );
        } catch (err) {
          ctx.logger.error({ err }, "Pool discovery failed or timed out");
        }
        state.currentActivity = "Waiting for pools";
        state.currentActivityUpdatedMs = Date.now();
        onStateUpdate?.(state);
        await sleep(intervalMs);
        continue;
      }

      state.currentActivity = "Building graph";
      state.currentActivityUpdatedMs = Date.now();
      onStateUpdate?.(state);

      const stateCache = ctx.watcherService.getStateCache();
      const graph = buildGraph(pools, stateCache);
      const cycles = enumerateCycles(graph, ctx.config.routing.maxHops);
      state.cachedPathCount = cycles.length;
      state.lastOpportunityCount = cycles.length;
      onStateUpdate?.(state);

      if (cycles.length === 0) {
        ctx.logger.debug({}, "No cycles found");
        state.currentActivity = "No cycles found";
        state.currentActivityUpdatedMs = Date.now();
        onStateUpdate?.(state);
        await sleep(intervalMs);
        continue;
      }

      state.currentActivity = "Evaluating pipeline";
      state.currentActivityUpdatedMs = Date.now();
      onStateUpdate?.(state);

      const gasPriceWei = await getGasPriceWei(ctx);
      state.gasPrice = weiToGwei(gasPriceWei);
      onStateUpdate?.(state);

      const options: PipelineOptions = {
        minProfitMaticWei: ctx.config.execution.minProfitWei,
        gasPriceWei,
        tokenToMaticRate: 1n,
        slippageBps: ctx.config.execution.slippageBps,
        revertRiskBps: ctx.config.execution.revertRiskBps,
        flashLoanSource: FlashLoanSource.BALANCER,
      };

      const result = evaluatePipeline(cycles, stateCache, options);

      state.lastPathsEvaluated = result.attempted;
      state.lastCandidateCount = result.profitableCount;
      state.lastProfitableCount = result.profitableCount;
      state.lastOpportunityCount = result.profitable.length;
      onStateUpdate?.(state);

      ctx.logger.info(
        {
          cyclesFound: cycles.length,
          attempted: result.attempted,
          profitable: result.profitableCount,
        },
        "Pipeline evaluation",
      );

      state.currentActivity = "Executing opportunities";
      state.currentActivityDetail = `Processing ${result.profitable.length} opportunities`;
      onStateUpdate?.(state);

      for (const [index, profitable] of result.profitable.entries()) {
        state.currentActivityProgress = {
          label: "Executing",
          completed: index + 1,
          total: result.profitable.length,
          unit: "txs",
        };
        onStateUpdate?.(state);

        const routeKey = routeKeyFromEdges(profitable.cycle.edges, profitable.cycle.startToken);
        const candidate: CandidateExecution = {
          routeKey,
          calldata: "",
          targetAddress: profitable.cycle.edges[0].poolAddress,
          value: 0n,
        };

        state.lastProfitableCount = (state.lastProfitableCount ?? 0) + 1;
        state.opportunities = (state.opportunities ?? []).concat([
          {
            Route: routeKey.slice(0, 30),
            Profit: profitable.assessment ? `${Number(profitable.assessment.netProfitAfterGas) / 1e18} MATIC` : "0",
            ROI: profitable.assessment ? `${(profitable.assessment.roi / 100).toFixed(1)}%` : "0%",
          },
        ]);
        onStateUpdate?.(state);

        ctx.logger.debug({ routeKey }, "Starting execution");
        const execResult = await ctx.executionService.execute(candidate);
        ctx.logger.debug({ routeKey, success: execResult.success }, "Execution completed");
        if (execResult.success) {
          state.totalTxSuccessful = (state.totalTxSuccessful ?? 0) + 1;
          ctx.logger.info({ txHash: execResult.txHash, routeKey }, "Transaction submitted");
        } else {
          state.totalTxReverted = (state.totalTxReverted ?? 0) + 1;
          ctx.logger.warn({ error: execResult.error, routeKey }, "Execution failed");
        }
        state.totalTxAttempted = (state.totalTxAttempted ?? 0) + 1;
        onStateUpdate?.(state);
      }
    } catch (err) {
      consecutiveErrors++;
      ctx.logger.error({ err }, "Pass loop error");
      state.status = "error";
      state.consecutiveErrors = consecutiveErrors;
      state.currentActivity = "Error";
      state.currentActivityUpdatedMs = Date.now();
      onStateUpdate?.(state);
    }

    state.passCount = (state.passCount ?? 0) + 1;
    state.lastPassDurationMs = Date.now() - startTime;
    state.lastUpdateMs = Date.now();
    state.currentActivity = "Idle";
    state.currentActivityUpdatedMs = Date.now();
    onStateUpdate?.(state);

    const elapsed = Date.now() - startTime;
    const waitMs = Math.max(0, intervalMs - elapsed);
    if (waitMs > 0) await sleep(waitMs);
  }

  ctx.logger.info({}, "Pass loop exited");
}
