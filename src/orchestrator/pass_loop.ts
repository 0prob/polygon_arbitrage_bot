import type { RuntimeContext } from "./boot.ts";
import { buildGraph } from "../services/strategy/graph.ts";
import { enumerateCycles, routeKeyFromEdges } from "../services/strategy/finder.ts";
import { evaluatePipeline, type PipelineOptions } from "../services/strategy/pipeline.ts";
import { FlashLoanSource } from "../core/types/execution.ts";
import type { CandidateExecution } from "../services/execution/service.ts";

async function getGasPriceWei(ctx: RuntimeContext): Promise<bigint> {
  try {
    const block = await ctx.publicClient.getBlock({ blockTag: "latest" });
    const baseFee = block.baseFeePerGas ?? 30n * 10n ** 9n;
    return baseFee * 2n + 30n * 10n ** 9n;
  } catch {
    return 30n * 10n ** 9n;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runPassLoop(ctx: RuntimeContext): Promise<void> {
  const intervalMs = ctx.config.routing.cycleRefreshIntervalMs;

  await ctx.executionService.start();
  ctx.watcherService.start();
  await ctx.hydrationService.start();
  await ctx.discoveryService.start();
  await ctx.mempoolService.start();

  ctx.logger.info({ intervalMs }, "Pass loop started");

  while (ctx.isRunning) {
    const startTime = Date.now();

    try {
      const pools = ctx.getPools();
      if (pools.length === 0) {
        ctx.logger.debug({}, "No pools available, waiting");
        await sleep(intervalMs);
        continue;
      }

      const stateCache = ctx.watcherService.getStateCache();
      const graph = buildGraph(pools, stateCache);
      const cycles = enumerateCycles(graph, ctx.config.routing.maxHops);

      if (cycles.length === 0) {
        ctx.logger.debug({}, "No cycles found");
        await sleep(intervalMs);
        continue;
      }

      const gasPriceWei = await getGasPriceWei(ctx);
      const options: PipelineOptions = {
        minProfitMaticWei: ctx.config.execution.minProfitWei,
        gasPriceWei,
        tokenToMaticRate: 1n,
        slippageBps: ctx.config.execution.slippageBps,
        revertRiskBps: ctx.config.execution.revertRiskBps,
        flashLoanSource: FlashLoanSource.BALANCER,
      };

      const result = evaluatePipeline(cycles, stateCache, options);

      ctx.logger.info({
        cyclesFound: cycles.length,
        attempted: result.attempted,
        profitable: result.profitableCount,
      }, "Pipeline evaluation");

      for (const profitable of result.profitable) {
        const routeKey = routeKeyFromEdges(profitable.cycle.edges, profitable.cycle.startToken);
        const candidate: CandidateExecution = {
          routeKey,
          calldata: "",
          targetAddress: profitable.cycle.edges[0].poolAddress,
          value: 0n,
        };

        const execResult = await ctx.executionService.execute(candidate);
        if (execResult.success) {
          ctx.logger.info({ txHash: execResult.txHash, routeKey }, "Transaction submitted");
        } else {
          ctx.logger.warn({ error: execResult.error, routeKey }, "Execution failed");
        }
      }
    } catch (err) {
      ctx.logger.error({ err }, "Pass loop error");
    }

    const elapsed = Date.now() - startTime;
    const waitMs = Math.max(0, intervalMs - elapsed);
    if (waitMs > 0) await sleep(waitMs);
  }

  ctx.logger.info({}, "Pass loop exited");
}
