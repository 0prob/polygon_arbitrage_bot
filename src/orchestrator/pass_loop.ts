import type { RuntimeContext } from "./boot.ts";
import { buildGraph } from "../services/strategy/graph.ts";
import { enumerateCycles, routeKeyFromEdges } from "../services/strategy/finder.ts";
import { evaluatePipeline, type PipelineOptions } from "../services/strategy/pipeline.ts";
import { FlashLoanSource } from "../core/types/execution.ts";
import type { CandidateExecution } from "../services/execution/service.ts";
import { buildArbTx, type BuilderRouteInput, type BuilderConfig } from "../services/execution/builder.ts";
import type { BotState } from "../cli/tui.ts";
import type { ActivityLog } from "../cli/activity.ts";
import { withTimeout } from "../infra/rpc/retry.ts";
import { buildStateCacheFromHyperIndex } from "../infra/db/hyperindex_reader.ts";

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

function buildCandidate(profitable: {
  cycle: { edges: Array<{ poolAddress: string; tokenIn: string; tokenOut: string; protocol: string; feeBps: bigint }>; startToken: string };
  result: { amountIn: bigint; amountOut: bigint; hopAmounts: bigint[]; tokenPath: string[]; poolPath: string[] };
}, executorAddress: string): CandidateExecution {
  const edges = profitable.cycle.edges.map((e) => ({
    poolAddress: e.poolAddress,
    tokenIn: e.tokenIn,
    tokenOut: e.tokenOut,
    protocol: e.protocol,
    zeroForOne: false,
    fee: Number(e.feeBps),
    swapFeeBps: Number(e.feeBps),
    metadata: {},
    tokenInIdx: 0,
    tokenOutIdx: 1,
  }));

  const route: BuilderRouteInput = {
    path: { startToken: profitable.cycle.startToken, edges },
    result: {
      amountIn: profitable.result.amountIn,
      amountOut: profitable.result.amountOut,
      hopAmounts: profitable.result.hopAmounts.map(BigInt),
      tokenPath: profitable.result.tokenPath.map(String),
      poolPath: profitable.result.poolPath.map(String),
    },
  };

  const config: BuilderConfig = { executorAddress, fromAddress: executorAddress };
  const built = buildArbTx(route, config, { slippageBps: 50 });

  return {
    routeKey: built.routeHash,
    calldata: built.data,
    targetAddress: built.to,
    value: built.value,
  };
}

export async function runPassLoop(ctx: RuntimeContext, onStateUpdate?: (update: Partial<BotState>) => void, activity?: ActivityLog): Promise<void> {
  const intervalMs = ctx.config.routing.cycleRefreshIntervalMs;
  const executorAddress = ctx.config.execution.executorAddress;

  await ctx.executionService.start();
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

      if (pools.length === 0) {
        activity?.("PASS", "No pools yet, triggering discovery (balancer, curve)");
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
        await sleep(intervalMs);
        continue;
      }

      activity?.("PASS", "Building graph...");

      let stateCache = ctx.hiDbPath ? buildStateCacheFromHyperIndex(ctx.hiDbPath, pools.map(p => p.address)) : new Map();
      if (stateCache.size === 0) {
        stateCache = ctx.watcherService.getStateCache();
      }
      const graph = buildGraph(pools, stateCache);
      const cycles = enumerateCycles(graph, ctx.config.routing.maxHops);
      state.cachedPathCount = cycles.length;
      state.lastOpportunityCount = cycles.length;
      onStateUpdate?.(state);

      if (cycles.length === 0) {
        activity?.("PASS", "No cycles found");
        ctx.logger.debug({}, "No cycles found");
        await sleep(intervalMs);
        continue;
      }

      activity?.("PASS", `Cycles: ${cycles.length} found, evaluating pipeline...`);

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

      activity?.("PASS", `Pipeline: ${result.attempted} evaluated, ${result.profitableCount} profitable`);

      if (result.profitable.length > 0) {
        activity?.("PASS", `Executing ${result.profitable.length} profitable cycles...`);
      }

      for (const [index, profitable] of result.profitable.entries()) {
        if (!ctx.isRunning) break;

        state.currentActivityProgress = {
          label: "Executing",
          completed: index + 1,
          total: result.profitable.length,
          unit: "txs",
        };
        onStateUpdate?.(state);

        const routeKey = routeKeyFromEdges(profitable.cycle.edges, profitable.cycle.startToken);
        activity?.("PASS", `  Exec ${index + 1}/${result.profitable.length}: ${routeKey.slice(0, 12)}`);
        let candidate: CandidateExecution;
        try {
          candidate = buildCandidate(profitable, executorAddress);
        } catch (err) {
          ctx.logger.error({ err, routeKey }, "Failed to build tx for cycle");
          continue;
        }

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
      activity?.("PASS", `Error: ${(err as Error).message}`);
      onStateUpdate?.(state);
    }

    state.passCount = (state.passCount ?? 0) + 1;
    state.lastPassDurationMs = Date.now() - startTime;
    state.lastUpdateMs = Date.now();
    onStateUpdate?.(state);

    const elapsed = Date.now() - startTime;
    activity?.("PASS", `Done (${elapsed}ms)`);
    const waitMs = Math.max(0, intervalMs - elapsed);
    if (waitMs > 0) await sleep(waitMs);
  }

  ctx.logger.info({}, "Pass loop exited");
}
