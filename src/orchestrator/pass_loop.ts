import type { RuntimeContext } from "./boot.ts";
import { type FoundCycle, find2HopCycles, find3HopCycles, find4HopCycles, routeKeyFromEdges } from "../services/strategy/finder.ts";
import { type RoutingGraph, buildGraph } from "../services/strategy/graph.ts";
import { evaluatePipeline, type PipelineOptions } from "../services/strategy/pipeline.ts";
import { FlashLoanSource } from "../core/types/execution.ts";
import type { CandidateExecution } from "../services/execution/service.ts";
import { buildStateCacheFromGraphQL, discoverPoolsFromHasura } from "../infra/hypersync/hyperindex_graphql.ts";
import type { PolygonPoolState } from "../services/crosschain/types.ts";
import { buildExecutionCandidate } from "../services/execution/candidate.ts";
import { WMATIC } from "../config/addresses.ts";
import type { PoolMeta } from "../core/types/pool.ts";
import type { EventBus } from "../tui/events.ts";
import { parseAbi } from "viem";

const V2_ABI = parseAbi(["function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)"]);
const V3_ABI = parseAbi(["function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)", "function liquidity() external view returns (uint128)"]);

const _failedPools = new Map<string, { count: number; lastTry: number }>();

async function fetchMissingPoolState(ctx: RuntimeContext, pools: PoolMeta[], currentCycles: FoundCycle[]): Promise<void> {
  const missingAddresses = new Set<string>();
  const now = Date.now();
  
  // Collect all missing pools from current cycles
  for (const cycle of currentCycles) {
    for (const edge of cycle.edges) {
      const addr = edge.poolAddress.toLowerCase();
      if (!ctx.stateCache.has(addr)) {
        const fail = _failedPools.get(addr);
        if (fail && fail.count > 3 && now - fail.lastTry < 300_000) continue;
        missingAddresses.add(addr);
      }
    }
  }

  if (missingAddresses.size === 0) return;

  // Fetch up to 5000 pools per pass to saturate the cache quickly
  const allMissing = Array.from(missingAddresses);
  const toFetch = allMissing
    .sort(() => Math.random() - 0.5)
    .slice(0, 5000);

  ctx.logger.info({ count: toFetch.length, totalMissing: missingAddresses.size }, "Massive RPC pre-fetch in progress");

  // Split into batches of 500 for multicall
  const BATCH_SIZE = 500;
  const batches: string[][] = [];
  for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
    batches.push(toFetch.slice(i, i + BATCH_SIZE));
  }

  await Promise.all(batches.map(async (batch) => {
    const calls: any[] = [];
    for (const addr of batch) {
      const meta = pools.find(p => p.address.toLowerCase() === addr);
      if (!meta) continue;
      if (meta.protocol.includes("v2")) {
        calls.push({ address: addr as `0x${string}`, abi: V2_ABI, functionName: "getReserves" });
      } else if (meta.protocol.includes("v3") || meta.protocol.includes("elastic")) {
        calls.push({ address: addr as `0x${string}`, abi: V3_ABI, functionName: "slot0" });
        calls.push({ address: addr as `0x${string}`, abi: V3_ABI, functionName: "liquidity" });
      }
    }

    if (calls.length === 0) return;

    try {
      const results = await ctx.publicClient.multicall({
        contracts: calls,
        allowFailure: true,
      });

      let resultIdx = 0;
      for (const addr of batch) {
        const meta = pools.find(p => p.address.toLowerCase() === addr);
        if (!meta) continue;

        if (meta.protocol.includes("v2")) {
          const res = results[resultIdx++];
          if (res?.status === "success" && res.result) {
            if (resultIdx <= 5) {
              console.log(`[multicall-diag] V2 Result for ${addr}:`, JSON.stringify(res.result, (k, v) => typeof v === "bigint" ? v.toString() : v));
            }
            const r = res.result as any;
            const r0 = r[0] !== undefined ? r[0] : r.reserve0;
            const r1 = r[1] !== undefined ? r[1] : r.reserve1;

            if (r0 !== undefined && r1 !== undefined) {
              ctx.stateCache.set(addr, { 
                reserve0: BigInt(r0), 
                reserve1: BigInt(r1), 
                initialized: true 
              });
              _failedPools.delete(addr);
            } else {
              const fail = _failedPools.get(addr) || { count: 0, lastTry: 0 };
              _failedPools.set(addr, { count: fail.count + 1, lastTry: now });
            }
          }
        } else if (meta.protocol.includes("v3") || meta.protocol.includes("elastic")) {
          const slot0Res = results[resultIdx++];
          const liqRes = results[resultIdx++];
          if (slot0Res?.status === "success" && slot0Res.result && liqRes?.status === "success") {
            const s = slot0Res.result as any;
            const sqrtPriceX96 = s[0] !== undefined ? s[0] : s.sqrtPriceX96;
            const tick = s[1] !== undefined ? s[1] : s.tick;

            if (sqrtPriceX96 !== undefined && tick !== undefined) {
              ctx.stateCache.set(addr, {
                sqrtPriceX96: BigInt(sqrtPriceX96),
                tick: Number(tick),
                liquidity: BigInt(liqRes.result as any),
                initialized: true
              });
              _failedPools.delete(addr);
            } else {
              const fail = _failedPools.get(addr) || { count: 0, lastTry: 0 };
              _failedPools.set(addr, { count: fail.count + 1, lastTry: now });
            }
          }
        }
      }
    } catch (err) {
      // Ignore individual batch failures
    }
  }));
}


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

const WMATIC_LOWER = WMATIC.toLowerCase();

function computeMaticRates(pools: PoolMeta[], stateCache: Map<string, Record<string, unknown>>): Map<string, bigint> {
  const rates = new Map<string, bigint>();
  rates.set(WMATIC_LOWER, 1n);

  for (let i = 0; i < 3; i++) {
    let changed = false;
    for (const pool of pools) {
      const t0 = pool.token0.toLowerCase();
      const t1 = pool.token1.toLowerCase();
      const hasT0 = rates.has(t0);
      const hasT1 = rates.has(t1);

      if (hasT0 === hasT1) continue;

      const state = stateCache.get(pool.address.toLowerCase());
      if (!state) continue;

      let rate: bigint | null = null;
      try {
        if (state.reserve0 !== undefined && state.reserve1 !== undefined) {
          const r0 = state.reserve0 as bigint;
          const r1 = state.reserve1 as bigint;
          if (r0 > 0n && r1 > 0n) {
            rate = hasT0 ? (rates.get(t0)! * r0) / r1 : (rates.get(t1)! * r1) / r0;
          }
        } else if (state.sqrtPriceX96 !== undefined) {
          const sq = state.sqrtPriceX96 as bigint;
          if (sq > 0n) {
            const p192 = sq * sq;
            rate = hasT0 ? (rates.get(t0)! * (1n << 192n)) / p192 : (rates.get(t1)! * p192) / (1n << 192n);
          }
        }
      } catch {
        continue;
      }

      if (rate !== null && rate > 0n) {
        rates.set(hasT0 ? t1 : t0, rate);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return rates;
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
  let lastDiscoveryTime = 0;

  const HF_INTERVAL = 200;
  const LF_INTERVAL = 1000;
  const DISCOVERY_INTERVAL = 60000;

  ctx.mempoolService.onSignal((signal) => {
    if (signal.type === "new_pool_pending") {
      ctx.logger.info({ txHash: signal.data.txHash }, "New pool deployment detected in mempool! Scheduling rapid discovery.");
      // Force discovery on next iteration
      lastDiscoveryTime = 0;
    }
  });

  while (ctx.isRunning) {
  const now = Date.now();
  const startTime = now;

  try {
  let pools = hasuraPoolsCache ?? ctx.getPools();

  if (pools.length === 0 || now - lastDiscoveryTime > DISCOVERY_INTERVAL) {
    const graphqlUrl = ctx.config.hasuraUrl;
    const secret = ctx.config.hasuraSecret;
    if (pools.length === 0) {
      ctx.logger.info({}, "No pools — discovering from Hasura");
    } else {
      ctx.logger.info({}, "Polling Hasura for new pools");
    }

    try {
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
        lastDiscoveryTime = now;
        ctx.logger.info({ discovered: pools.length }, "Updated pools from Hasura");
      }
    } catch (e) {
      ctx.logger.warn({ err: e }, "Failed to discover pools from Hasura");
    }
  }
      const stateCache = ctx.stateCache;

      // --- SYNTHETIC ARB INJECTION ---
      // TokenA (WMATIC) -> TokenB (Fake) -> TokenA
      const fakeToken = "0xffffffffffffffffffffffffffffffffffffffff" as `0x${string}`;
      const pool1 = "0x1111111111111111111111111111111111111111" as `0x${string}`;
      const pool2 = "0x2222222222222222222222222222222222222222" as `0x${string}`;
      
      const setSyntheticState = () => {
        stateCache.set(pool1, { reserve0: 1000n * 10n**18n, reserve1: 1000n * 10n**18n, initialized: true, isSynthetic: true });
        stateCache.set(pool2, { reserve0: 1000n * 10n**18n, reserve1: 1100n * 10n**18n, initialized: true, isSynthetic: true });
      };
      setSyntheticState();

      const syntheticPools: PoolMeta[] = [
        { address: pool1, protocol: "uniswap_v2", token0: WMATIC, token1: fakeToken, tokens: [WMATIC, fakeToken] },
        { address: pool2, protocol: "uniswap_v2", token0: WMATIC, token1: fakeToken, tokens: [WMATIC, fakeToken] },
      ];
      // -------------------------------

      // Force refresh state for ALL active pools via RPC multicall on every pass
      if (pools.length > 0) {
        // Create dummy cycles so fetchMissingPoolState picks up all addresses
        const dummyCycles = pools.map(p => ({ edges: [{ poolAddress: p.address }] } as any));
        await fetchMissingPoolState(ctx, pools, dummyCycles);
        // Ensure synthetic state is still there
        setSyntheticState();
      }


      const shouldLowFreq = (now - lastRefreshTime) >= LF_INTERVAL;
      
      if (shouldLowFreq || !cachedGraph) {
        cachedGraph = deps.buildGraph([...pools, ...syntheticPools], stateCache);
        
        const maxHops = 4; // Force 4 for discovery
        cached2HopCycles = deps.find2HopCycles(cachedGraph);
        
        const longCycles: FoundCycle[] = [];
        longCycles.push(...deps.find3HopCycles(cachedGraph));
        const hubTokens = (ctx.config.discovery.hubTokens || []) as `0x${string}`[];
        longCycles.push(...deps.find4HopCycles(cachedGraph, undefined, hubTokens));
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

      // Fill in missing pool states via RPC multicall if needed
      await fetchMissingPoolState(ctx, pools, currentCycles);

      const gasSnapshot = ctx.gasOracle.getSnapshot();
      if (!gasSnapshot) {
        ctx.logger.debug({}, "Waiting for gas oracle snapshot");
        await sleep(100);
        continue;
      }

      const tokenToMaticRates = computeMaticRates(pools, stateCache);
      ctx.logger.debug({ ratesCount: tokenToMaticRates.size }, "Updated token conversion rates");

      const options: PipelineOptions = {
        minProfitMaticWei: ctx.config.execution.minProfitWei,
        gasPriceWei: gasSnapshot.gasPrice,
        tokenToMaticRates,
        slippageBps: ctx.config.execution.slippageBps,
        revertRiskBps: ctx.config.execution.revertRiskBps,
        flashLoanSource: FlashLoanSource.BALANCER,
      };

      const result = deps.evaluatePipeline(currentCycles, stateCache, options);

      if (result.attempted > 0) {
        ctx.logger.info(
          {
            attempted: result.attempted,
            simulated: result.simulated,
            pruned: result.pruned,
            noRate: result.noRate,
            profitable: result.profitableCount,
            maxGrossMatic: result.maxGrossProfitMatic !== undefined ? (result.maxGrossProfitMatic / 10n**15n).toString() + "mMATIC" : "N/A",
            rates: tokenToMaticRates.size,
            cache: stateCache.size,
            isLowFreq: shouldLowFreq,
          },
          "Cycle assessment complete",
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
