import type { RuntimeContext } from "./boot.ts";
import { type FoundCycle, find2HopCycles, find3HopCycles, find4HopCycles, routeKeyFromEdges } from "../services/strategy/finder.ts";
import { type RoutingGraph, buildGraph } from "../services/strategy/graph.ts";
import { evaluatePipeline, type PipelineOptions } from "../services/strategy/pipeline.ts";
import { FlashLoanSource } from "../core/types/execution.ts";
import type { CandidateExecution } from "../services/execution/service.ts";
import { buildStateCacheFromGraphQL, discoverPoolsFromHasura } from "../infra/hypersync/hyperindex_graphql.ts";
import type { PolygonPoolState } from "../services/crosschain/types.ts";
import { buildExecutionCandidate } from "../services/execution/candidate.ts";
import { WMATIC, USDC, USDC_NATIVE, USDT, DAI } from "../config/addresses.ts";
import type { PoolMeta } from "../core/types/pool.ts";
import type { EventBus } from "../tui/events.ts";

export interface PassLoopDeps {
  buildGraph: typeof buildGraph;
  find2HopCycles: typeof find2HopCycles;
  find3HopCycles: typeof find3HopCycles;
  find4HopCycles: typeof find4HopCycles;
  evaluatePipeline: typeof evaluatePipeline;
  buildStateCacheFromGraphQL: typeof buildStateCacheFromGraphQL;
  discoverPoolsFromHasura: typeof discoverPoolsFromHasura;
  routeKeyFromEdges: (edges: any[], startToken: `0x${string}`) => string;
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

    if (state.reserve0 !== undefined && state.reserve1 !== undefined) {
      const reserve0 = state.reserve0 as bigint;
      const reserve1 = state.reserve1 as bigint;
      if (reserve0 <= 0n || reserve1 <= 0n) continue;
      const maticPerStableUnit = t0 === WMATIC_LOWER ? reserve0 / reserve1 : reserve1 / reserve0;
      if (maticPerStableUnit > 0n) return maticPerStableUnit;
    }

    if (state.sqrtPriceX96 !== undefined) {
      const sqrtPriceX96 = state.sqrtPriceX96 as bigint;
      if (sqrtPriceX96 <= 0n) continue;
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

export const DEFAULT_DEPS: PassLoopDeps = {
  buildGraph,
  find2HopCycles,
  find3HopCycles,
  find4HopCycles,
  evaluatePipeline,
  buildStateCacheFromGraphQL,
  discoverPoolsFromHasura,
  routeKeyFromEdges,
  buildExecutionCandidate,
};

export async function runPassLoop(ctx: RuntimeContext, deps: PassLoopDeps = DEFAULT_DEPS, bus?: EventBus): Promise<void> {
  const executorAddress = ctx.config.execution.executorAddress;

  await ctx.executionService.start();
  await ctx.mempoolService.start();

  bus?.emit({ type: "pass_loop_started", intervalMs: 200 });
  ctx.logger.info({}, "Pass loop started with multi-frequency cycles");

  let cachedGraph: RoutingGraph | null = null;
  let cached2HopCycles: FoundCycle[] = [];
  let cached3And4HopCycles: FoundCycle[] = [];
  let hasuraPoolsCache: PoolMeta[] | null = null;
  let _lastStateRefresh = 0;
  let lastRefreshTime = 0;
  
  const HF_INTERVAL = 200;
  const LF_INTERVAL = 1000;

  while (ctx.isRunning) {
    const now = Date.now();
    const startTime = now;

    try {
      let pools = hasuraPoolsCache ?? ctx.getPools();

      if (pools.length === 0) {
        const graphqlUrl = ctx.config.hasuraUrl;
        const secret = ctx.config.hasuraSecret;
        ctx.logger.info({}, "No pools — discovering from Hasura");
        const hasuraPools = await deps.discoverPoolsFromHasura(graphqlUrl, secret);
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
        const gqlCache = await deps.buildStateCacheFromGraphQL(graphqlUrl, secret);
        for (const [addr, state] of gqlCache) {
          stateCache.set(addr, state);
        }
        _lastStateRefresh = Date.now();
      }

      const shouldLowFreq = (now - lastRefreshTime) >= LF_INTERVAL;
      
      if (shouldLowFreq || !cachedGraph) {
        cachedGraph = deps.buildGraph(pools, stateCache);
        
        const maxHops = ctx.config.routing.maxHops;
        cached2HopCycles = maxHops >= 2 ? deps.find2HopCycles(cachedGraph) : [];
        
        const longCycles: FoundCycle[] = [];
        if (maxHops >= 3) longCycles.push(...deps.find3HopCycles(cachedGraph));
        if (maxHops >= 4) longCycles.push(...deps.find4HopCycles(cachedGraph));
        cached3And4HopCycles = longCycles;

        lastRefreshTime = now;
        const poolsPerProtocol: Record<string, number> = {};
        for (const p of pools) {
          poolsPerProtocol[p.protocol] = (poolsPerProtocol[p.protocol] || 0) + 1;
        }
        ctx.logger.info(
          { 
            pools: pools.length, 
            cycles2: cached2HopCycles.length, 
            cycles34: cached3And4HopCycles.length,
            maxHops
          }, 
          "Graph and cycles re-enumerated"
        );
        bus?.emit({ 
          type: "graph_built", 
          poolCount: pools.length, 
          cycleCount: cached2HopCycles.length + cached3And4HopCycles.length,
          poolsPerProtocol,
          maxHops
        });
      }

      const currentCycles = shouldLowFreq ? [...cached2HopCycles, ...cached3And4HopCycles] : cached2HopCycles;

      if (currentCycles.length === 0) {
        await sleep(HF_INTERVAL);
        continue;
      }

      const gasSnapshot = ctx.gasOracle.getSnapshot();
      if (!gasSnapshot) {
        ctx.logger.debug({}, "Waiting for gas oracle snapshot");
        await sleep(100);
        continue;
      }

      const tokenToMaticRate = computeTokenToMaticRate(pools, stateCache);

      const options: PipelineOptions = {
        minProfitMaticWei: ctx.config.execution.minProfitWei,
        gasPriceWei: gasSnapshot.gasPrice,
        tokenToMaticRate,
        slippageBps: ctx.config.execution.slippageBps,
        revertRiskBps: ctx.config.execution.revertRiskBps,
        flashLoanSource: FlashLoanSource.BALANCER,
      };

      const result = deps.evaluatePipeline(currentCycles, stateCache, options);

      if (result.profitableCount > 0) {
        ctx.logger.info(
          {
            attempted: result.attempted,
            profitable: result.profitableCount,
            isLowFreq: shouldLowFreq,
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
    bus?.emit({ type: "heartbeat", elapsedMs: elapsed });
    const waitMs = Math.max(0, HF_INTERVAL - elapsed);
    if (waitMs > 0) await sleep(waitMs);
  }

  ctx.logger.info({}, "Pass loop exited");
}
