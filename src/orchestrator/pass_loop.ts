import type { RuntimeContext } from "./boot.ts";
import { buildGraph, type RoutingGraph } from "../services/strategy/graph.ts";
import { type FoundCycle, enumerateCycles, routeKeyFromEdges } from "../services/strategy/finder.ts";
import { evaluatePipeline, type PipelineOptions } from "../services/strategy/pipeline.ts";
import { FlashLoanSource } from "../core/types/execution.ts";
import type { CandidateExecution } from "../services/execution/service.ts";
import { buildStateCacheFromGraphQL, discoverPoolsFromHasura } from "../infra/hypersync/hyperindex_graphql.ts";
import type { PolygonPoolState } from "../services/crosschain/types.ts";
import { buildExecutionCandidate } from "../services/execution/candidate.ts";
import { WMATIC, USDC, USDC_NATIVE, USDT, DAI } from "../config/addresses.ts";
import type { PoolMeta } from "../core/types/pool.ts";
import type { EventBus } from "../tui/events.ts";
import { calculateLiquidityUsd } from "../core/assessment/liquidity.ts";

export interface PassLoopDeps {
  buildGraph: typeof buildGraph;
  enumerateCycles: typeof enumerateCycles;
  evaluatePipeline: typeof evaluatePipeline;
  buildStateCacheFromGraphQL: typeof buildStateCacheFromGraphQL;
  discoverPoolsFromHasura: typeof discoverPoolsFromHasura;
  routeKeyFromEdges: typeof routeKeyFromEdges;
  buildExecutionCandidate: typeof buildExecutionCandidate;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const STABLECOINS = new Set([USDC.toLowerCase(), USDC_NATIVE.toLowerCase(), USDT.toLowerCase(), DAI.toLowerCase()]);
const WMATIC_LOWER = WMATIC.toLowerCase();

function computeTokenToMaticRate(pools: PoolMeta[], stateCache: Map<string, Record<string, unknown>>): bigint {
  for (const pool of pools) {
    const t0 = pool.token0.toLowerCase();
    const t1 = pool.token1.toLowerCase();
    const stableToken = STABLECOINS.has(t0) ? t0 : STABLECOINS.has(t1) ? t1 : null;
    if (!stableToken) continue;
    const hasMatic = t0 === WMATIC_LOWER || t1 === WMATIC_LOWER;
    if (!hasMatic) continue;

    const state = stateCache.get(pool.address.toLowerCase());
    if (!state) continue;

    // V2 pool: reserve0/reserve1 are in smallest units
    if (state.reserve0 !== undefined && state.reserve1 !== undefined) {
      const reserve0 = state.reserve0 as bigint;
      const reserve1 = state.reserve1 as bigint;
      if (reserve0 <= 0n || reserve1 <= 0n) continue;
      const maticPerStableUnit = t0 === WMATIC_LOWER ? reserve0 / reserve1 : reserve1 / reserve0;
      if (maticPerStableUnit > 0n) return maticPerStableUnit;
    }

    // V3 pool: sqrtPriceX96 = sqrt(token1/token0) * 2^96
    if (state.sqrtPriceX96 !== undefined) {
      const sqrtPriceX96 = state.sqrtPriceX96 as bigint;
      if (sqrtPriceX96 <= 0n) continue;
      // Price = token1/token0
      const stableIsToken0 = t0 === stableToken;
      const priceX192 = sqrtPriceX96 * sqrtPriceX96;
      if (stableIsToken0) {
        return priceX192 / (1n << 192n);
      }
      return (1n << 192n) / priceX192;
    }
  }

  return 1n;
}

const DEFAULT_DEPS: PassLoopDeps = {
  buildGraph,
  enumerateCycles,
  evaluatePipeline,
  buildStateCacheFromGraphQL,
  discoverPoolsFromHasura,
  routeKeyFromEdges,
  buildExecutionCandidate,
};

export async function runPassLoop(ctx: RuntimeContext, deps: PassLoopDeps = DEFAULT_DEPS, bus?: EventBus): Promise<void> {
  const intervalMs = ctx.config.routing.cycleRefreshIntervalMs;
  const executorAddress = ctx.config.execution.executorAddress;

  await ctx.executionService.start();
  await ctx.mempoolService.start();

  bus?.emit({ type: "pass_loop_started", intervalMs });
  ctx.logger.info({ intervalMs }, "Pass loop started");

  let lastPoolCount = 0;
  let cachedCycles: FoundCycle[] = [];
  let cachedGraph: RoutingGraph | null = null;
  let idleIterations = 0;
  let hasuraPoolsCache: PoolMeta[] | null = null;
  let _lastStateRefresh = 0;

  while (ctx.isRunning) {
    const startTime = Date.now();

    try {
      let pools = hasuraPoolsCache ?? ctx.getPools();

      if (pools.length === 0) {
        const graphqlUrl = ctx.config.hasuraUrl;
        const secret = ctx.config.hasuraSecret;
        ctx.logger.info({}, "No pools — discovering from Hasura");
        const hasuraPools = await discoverPoolsFromHasura(graphqlUrl, secret);
        if (hasuraPools.length > 0) {
          hasuraPoolsCache = hasuraPools.map(p => ({
            address: p.address as `0x${string}`,
            protocol: p.protocol,
            token0: (p.tokens[0] ?? "") as `0x${string}`,
            token1: (p.tokens[1] ?? "") as `0x${string}`,
            tokens: p.tokens as `0x${string}`[],
          }));
          pools = hasuraPoolsCache;
          ctx.logger.info({ discovered: pools.length }, "Discovered pools from Hasura");
        }
      }

      const stateCache = ctx.stateCache;

      if (stateCache.size === 0 || (stateCache.size > 0 && Date.now() - _lastStateRefresh > 2000)) {
        const graphqlUrl = ctx.config.hasuraUrl;
        const secret = ctx.config.hasuraSecret;
        const gqlCache = await buildStateCacheFromGraphQL(graphqlUrl, secret);
        for (const [addr, state] of gqlCache) {
          if (!stateCache.has(addr)) {
            stateCache.set(addr, state);
          }
        }
        _lastStateRefresh = Date.now();
      }

      const tokenToMaticRate = computeTokenToMaticRate(pools, stateCache);

      // Filter pools by liquidity floor
      const liquidityFloor = ctx.config.routing.liquidityFloorUsd;
      if (liquidityFloor && liquidityFloor > 0n) {
        pools = pools.filter(p => {
          const state = stateCache.get(p.address.toLowerCase());
          if (!state) return false;
          return calculateLiquidityUsd(p, state, tokenToMaticRate) >= liquidityFloor;
        });
      }

      // Rebuild graph only if pools change.
      // State changes are now handled by in-place updates to state objects referenced in graph edges.
      if (pools.length !== lastPoolCount || !cachedGraph) {
        cachedGraph = deps.buildGraph(pools, stateCache);
        cachedCycles = deps.enumerateCycles(cachedGraph, ctx.config.routing.maxHops);
        lastPoolCount = pools.length;
        ctx.logger.info({ pools: pools.length, cycles: cachedCycles.length }, "Graph and cycles re-enumerated");
        bus?.emit({ type: "graph_built", poolCount: pools.length, cycleCount: cachedCycles.length });
      }

      if (cachedCycles.length === 0) {
        await sleep(intervalMs);
        continue;
      }

      if (stateCache.size === 0) {
        ctx.logger.warn({}, "No pool state data available — waiting for indexer to populate state");
        bus?.emit({ type: "error", component: "Pipeline", message: "No pool state data" });
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
        tokenToMaticRate,
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
          bus?.emit({ type: "opportunity_found", routeKey, profitWei: profitable.assessment.netProfitAfterGas });

          let candidate: CandidateExecution;
          try {
            candidate = deps.buildExecutionCandidate(
              profitable,
              { executorAddress, fromAddress: executorAddress },
              { slippageBps: Number(options.slippageBps ?? 50n) },
            );
          } catch (err) {
            ctx.logger.error({ err, routeKey }, "Failed to build tx for cycle");
            continue;
          }

          ctx.logger.info({ routeKey, profit: profitable.assessment.netProfitAfterGas }, "Executing opportunity");
          bus?.emit({ type: "execution_submitted", routeKey });
          const execResult = await ctx.executionService.execute(candidate);

          if (execResult.success) {
            ctx.logger.info({ txHash: execResult.txHash, routeKey }, "Transaction submitted successfully");
            bus?.emit({ type: "execution_result", routeKey, success: true, txHash: execResult.txHash });
          } else {
            ctx.logger.warn({ error: execResult.error, routeKey }, "Execution failed");
            bus?.emit({ type: "execution_result", routeKey, success: false, error: execResult.error });
          }
        }
      }

      // Cross-chain arb (if enabled)
      if (ctx.config.crossChainArb?.enabled) {
        try {
          const polygonPoolStates: PolygonPoolState[] = pools.map((p) => ({
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

    idleIterations++;
    if (idleIterations % 60 === 0) {
      ctx.logger.debug({ cycles: cachedCycles.length, elapsed }, "Pass loop heartbeat");
    }
  }

  ctx.logger.info({}, "Pass loop exited");
}
