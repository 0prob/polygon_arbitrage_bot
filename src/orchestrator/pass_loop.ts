import type { RuntimeContext } from "./boot.ts";
import { buildGraph, type RoutingGraph } from "../services/strategy/graph.ts";
import { type FoundCycle, enumerateCycles, routeKeyFromEdges } from "../services/strategy/finder.ts";
import { evaluatePipeline, type PipelineOptions } from "../services/strategy/pipeline.ts";
import { FlashLoanSource } from "../core/types/execution.ts";
import type { CandidateExecution } from "../services/execution/service.ts";
import { buildArbTx, type BuilderRouteInput, type BuilderConfig } from "../services/execution/builder.ts";
import { buildStateCacheFromHyperIndex } from "../infra/db/hyperindex_reader.ts";
import type { PolygonPoolState } from "../services/crosschain/types.ts";

export interface PassLoopDeps {
  buildGraph: typeof buildGraph;
  enumerateCycles: typeof enumerateCycles;
  evaluatePipeline: typeof evaluatePipeline;
  buildArbTx: typeof buildArbTx;
  buildStateCacheFromHyperIndex: typeof buildStateCacheFromHyperIndex;
  routeKeyFromEdges: typeof routeKeyFromEdges;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildCandidate(profitable: {
  cycle: { edges: Array<{ poolAddress: string; tokenIn: string; tokenOut: string; protocol: string; feeBps: bigint; zeroForOne?: boolean }>; startToken: string };
  result: { amountIn: bigint; amountOut: bigint; hopAmounts: bigint[]; tokenPath: string[]; poolPath: string[] };
}, executorAddress: string, slippageBps: number, deps: PassLoopDeps): CandidateExecution {
  const edges = profitable.cycle.edges.map((e) => {
    const fee = Number(e.feeBps);
    return {
      poolAddress: e.poolAddress,
      tokenIn: e.tokenIn,
      tokenOut: e.tokenOut,
      protocol: e.protocol,
      zeroForOne: e.zeroForOne ?? e.tokenIn < e.tokenOut,
      fee,
      swapFeeBps: fee,
      metadata: {},
      tokenInIdx: 0,
      tokenOutIdx: 1,
    };
  });

  const route: BuilderRouteInput = {
    path: { startToken: profitable.cycle.startToken, edges },
    result: {
      amountIn: profitable.result.amountIn,
      amountOut: profitable.result.amountOut,
      hopAmounts: profitable.result.hopAmounts,
      tokenPath: profitable.result.tokenPath,
      poolPath: profitable.result.poolPath,
    },
  };

  const config: BuilderConfig = { executorAddress, fromAddress: executorAddress };
  const built = deps.buildArbTx(route, config, { slippageBps });

  return {
    routeKey: built.routeHash,
    calldata: built.data,
    targetAddress: built.to,
    value: built.value,
  };
}

const DEFAULT_DEPS: PassLoopDeps = {
  buildGraph,
  enumerateCycles,
  evaluatePipeline,
  buildArbTx,
  buildStateCacheFromHyperIndex,
  routeKeyFromEdges,
};

export async function runPassLoop(ctx: RuntimeContext, deps: PassLoopDeps = DEFAULT_DEPS): Promise<void> {
  const intervalMs = ctx.config.routing.cycleRefreshIntervalMs;
  const executorAddress = ctx.config.execution.executorAddress;

  await ctx.executionService.start();
  await ctx.mempoolService.start();

  ctx.logger.info({ intervalMs }, "Pass loop started");

  let lastPoolCount = 0;
  let cachedCycles: FoundCycle[] = [];
  let cachedGraph: RoutingGraph | null = null;

  while (ctx.isRunning) {
    const startTime = Date.now();

    try {
      const pools = ctx.getPools();

      if (pools.length === 0) {
        ctx.logger.info({}, "No pools found, waiting for HyperIndex discovery");
        await sleep(Math.min(intervalMs, 5000));
        continue;
      }

      const stateCache = deps.buildStateCacheFromHyperIndex(ctx.hiDbPath, pools.map(p => p.address));
      
      // Rebuild graph only if pools change. 
      // State changes are now handled by in-place updates to state objects referenced in graph edges.
      if (pools.length !== lastPoolCount || !cachedGraph) {
        cachedGraph = deps.buildGraph(pools, stateCache);
        cachedCycles = deps.enumerateCycles(cachedGraph, ctx.config.routing.maxHops);
        lastPoolCount = pools.length;
        ctx.logger.info({ pools: pools.length, cycles: cachedCycles.length }, "Graph and cycles re-enumerated");
      }

      if (cachedCycles.length === 0) {
        await sleep(intervalMs);
        continue;
      }

      const gasSnapshot = ctx.gasOracle.getSnapshot();
      if (!gasSnapshot) {
        ctx.logger.debug({}, "Waiting for gas oracle snapshot");
        await sleep(100);
        continue;
      }

      const options: PipelineOptions = {
        minProfitMaticWei: ctx.config.execution.minProfitWei,
        gasPriceWei: gasSnapshot.gasPrice,
        tokenToMaticRate: 1n, // Assume MATIC for now, could be dynamic
        slippageBps: ctx.config.execution.slippageBps,
        revertRiskBps: ctx.config.execution.revertRiskBps,
        flashLoanSource: FlashLoanSource.BALANCER,
      };

      const result = deps.evaluatePipeline(cachedCycles, stateCache, options);

      if (result.profitableCount > 0) {
        ctx.logger.info(
          {
            attempted: result.attempted,
            profitable: result.profitableCount,
          },
          "Profitable opportunities found",
        );

        for (const profitable of result.profitable) {
          if (!ctx.isRunning) break;

          const routeKey = deps.routeKeyFromEdges(profitable.cycle.edges, profitable.cycle.startToken);
          let candidate: CandidateExecution;
          try {
            candidate = buildCandidate(profitable, executorAddress, Number(options.slippageBps ?? 50n), deps);
          } catch (err) {
            ctx.logger.error({ err, routeKey }, "Failed to build tx for cycle");
            continue;
          }

          ctx.logger.info({ routeKey, profit: profitable.assessment.netProfitAfterGas }, "Executing opportunity");
          const execResult = await ctx.executionService.execute(candidate);
          
          if (execResult.success) {
            ctx.logger.info({ txHash: execResult.txHash, routeKey }, "Transaction submitted successfully");
          } else {
            ctx.logger.warn({ error: execResult.error, routeKey }, "Execution failed");
          }
        }
      }

      // Cross-chain arb (if enabled)
      if (ctx.config.crossChainArb?.enabled) {
        try {
          const polygonPoolStates: PolygonPoolState[] = pools.map(p => ({
            address: p.address,
            protocol: p.protocol,
            token0: p.token0,
            token1: p.token1,
          }));
          const crossChainRoutes = await ctx.crossChainScanner!.findProfitableRoutes(polygonPoolStates, stateCache, []);
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
      ctx.logger.error({ err }, "Pass loop error");
    }

    const elapsed = Date.now() - startTime;
    const waitMs = Math.max(0, intervalMs - elapsed);
    if (waitMs > 0) await sleep(waitMs);
  }

  ctx.logger.info({}, "Pass loop exited");
}
