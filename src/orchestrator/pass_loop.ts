import type { RuntimeContext } from "./boot.ts";
import { buildGraph } from "../services/strategy/graph.ts";
import { enumerateCycles, routeKeyFromEdges } from "../services/strategy/finder.ts";
import { evaluatePipeline, type PipelineOptions } from "../services/strategy/pipeline.ts";
import { FlashLoanSource } from "../core/types/execution.ts";
import type { CandidateExecution } from "../services/execution/service.ts";
import { buildArbTx, type BuilderRouteInput, type BuilderConfig } from "../services/execution/builder.ts";
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

export async function runPassLoop(ctx: RuntimeContext): Promise<void> {
  const intervalMs = ctx.config.routing.cycleRefreshIntervalMs;
  const executorAddress = ctx.config.execution.executorAddress;

  await ctx.executionService.start();
  await ctx.mempoolService.start();

  ctx.logger.info({ intervalMs }, "Pass loop started");

  let consecutiveErrors = 0;

  while (ctx.isRunning) {
    const startTime = Date.now();

    try {
      const pools = ctx.getPools();

      if (pools.length === 0) {
        ctx.logger.info({}, "No pools found, waiting for HyperIndex discovery");
        await sleep(intervalMs);
        continue;
      }

      const stateCache = buildStateCacheFromHyperIndex(ctx.hiDbPath, pools.map(p => p.address));
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

      ctx.logger.info(
        {
          cyclesFound: cycles.length,
          attempted: result.attempted,
          profitable: result.profitableCount,
        },
        "Pipeline evaluation",
      );

      for (const profitable of result.profitable) {
        if (!ctx.isRunning) break;

        const routeKey = routeKeyFromEdges(profitable.cycle.edges, profitable.cycle.startToken);
        let candidate: CandidateExecution;
        try {
          candidate = buildCandidate(profitable, executorAddress);
        } catch (err) {
          ctx.logger.error({ err, routeKey }, "Failed to build tx for cycle");
          continue;
        }

        ctx.logger.debug({ routeKey }, "Starting execution");
        const execResult = await ctx.executionService.execute(candidate);
        ctx.logger.debug({ routeKey, success: execResult.success }, "Execution completed");
        if (execResult.success) {
          ctx.logger.info({ txHash: execResult.txHash, routeKey }, "Transaction submitted");
        } else {
          ctx.logger.warn({ error: execResult.error, routeKey }, "Execution failed");
        }
      }

      // Cross-chain arb (if enabled)
      if (ctx.config.crossChainArb?.enabled) {
        try {
          const crossChainRoutes = await ctx.crossChainScanner!.findProfitableRoutes(pools, []);
          for (const route of crossChainRoutes) {
            if (!ctx.isRunning) break;
            ctx.logger.info({ route }, "Cross-chain arb opportunity found");
            const success = await ctx.solverBot!.executeCrossChainArb(route);
            ctx.logger.info({ routeKey: route.flashPool, success }, "Cross-chain arb executed");
          }
        } catch (err) {
          ctx.logger.error({ err }, "Cross-chain arb loop error");
        }
      }
    } catch (err) {
      consecutiveErrors++;
      ctx.logger.error({ err }, "Pass loop error");
    }

    const elapsed = Date.now() - startTime;
    const waitMs = Math.max(0, intervalMs - elapsed);
    if (waitMs > 0) await sleep(waitMs);
  }

  ctx.logger.info({}, "Pass loop exited");
}
