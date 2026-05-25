import type { RuntimeContext } from "./boot.ts";
import { type FoundCycle, findCycles, enumerateCycles, routeKeyFromEdges } from "../services/strategy/finder.ts";
import { type RoutingGraph, buildGraph } from "../services/strategy/graph.ts";
import { evaluatePipeline, type PipelineOptions } from "../services/strategy/pipeline.ts";
import { FlashLoanSource } from "../core/types/execution.ts";
import { groupCompatibleCandidates, type CandidateExecution } from "../services/execution/service.ts";
import { discoverPoolsFromHasura, buildStateCacheFromGraphQL } from "../infra/hypersync/hyperindex_graphql.ts";
import type { PolygonPoolState } from "../services/crosschain/types.ts";
import { buildExecutionCandidate } from "../services/execution/candidate.ts";
import { WMATIC } from "../config/addresses.ts";
import type { PoolMeta } from "../core/types/pool.ts";
import type { EventBus } from "../tui/events.ts";
import { parseAbi } from "viem";
import { buildStatusPayload, writeStatusFile } from "./status_writer.ts";

const V2_ABI = parseAbi(["function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)"]);
const V3_ABI = parseAbi(["function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)", "function liquidity() external view returns (uint128)"]);

const _failedPools = new Map<string, { count: number; lastTry: number }>();

async function fetchMissingPoolState(ctx: RuntimeContext, pools: PoolMeta[], currentCycles: FoundCycle[]): Promise<void> {
  const missingAddresses = new Set<string>();
  const now = Date.now();

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

  const toFetch = Array.from(missingAddresses);

  ctx.logger.info({ count: toFetch.length }, "RPC pre-fetch in progress");

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
            const r = res.result as any;
            const r0 = r[0] !== undefined ? r[0] : r.reserve0;
            const r1 = r[1] !== undefined ? r[1] : r.reserve1;

            if (r0 !== undefined && r1 !== undefined) {
              ctx.stateCache.set(addr, {
                reserve0: BigInt(r0),
                reserve1: BigInt(r1),
                initialized: true,
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
                initialized: true,
              });
              _failedPools.delete(addr);
            } else {
              const fail = _failedPools.get(addr) || { count: 0, lastTry: 0 };
              _failedPools.set(addr, { count: fail.count + 1, lastTry: now });
            }
          }
        }
      }
    } catch {
      // Ignore individual batch failures
    }
  }));
}

export interface PassLoopDeps {
  buildGraph: typeof buildGraph;
  findCycles: typeof findCycles;
  enumerateCycles: typeof enumerateCycles;
  evaluatePipeline: typeof evaluatePipeline;
  discoverPoolsFromHasura: typeof discoverPoolsFromHasura;
  buildStateCacheFromGraphQL: typeof buildStateCacheFromGraphQL;
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
  findCycles,
  enumerateCycles,
  evaluatePipeline,
  discoverPoolsFromHasura,
  buildStateCacheFromGraphQL,
  routeKeyFromEdges,
  buildExecutionCandidate,
};

export async function runPassLoop(ctx: RuntimeContext, deps: PassLoopDeps = DEFAULT_DEPS, bus?: EventBus): Promise<void> {
  const executorAddress = ctx.config.execution.executorAddress;

  await ctx.executionService.start();
  await ctx.mempoolService.start();

  // Start WebSocket subscriber if configured
  if (ctx.wsSubscriber) {
    try {
      await ctx.wsSubscriber.start();
      ctx.logger.info({}, "WebSocket subscriber started for real-time events");

      // Wire WebSocket events into mempool + pass loop
      ctx.wsSubscriber.onEvent((event) => {
        if (event.type === "newPendingTx" && event.to) {
          ctx.mempoolService.processPendingTx({
            hash: event.hash,
            to: event.to,
            input: event.input,
            value: event.value,
          });
        }
        if (event.type === "newHead") {
          // Track new head for freshness — the existing LF_INTERVAL handles re-evaluation
          ctx.metrics.currentCyclesPerMinute = ctx.metrics.currentCyclesPerMinute || 1;
        }
      });
    } catch (err) {
      ctx.logger.warn({ err }, "Failed to start WebSocket subscriber");
    }
  }

  bus?.emit({ type: "pass_loop_started", intervalMs: 200 });
  ctx.logger.info({}, "Pass loop started with multi-frequency cycles");

  let cachedGraph: RoutingGraph | null = null;
  let cachedCycles: FoundCycle[] = [];
  let hasuraPoolsCache: PoolMeta[] | null = null;
  let lastRefreshTime = 0;
  let lastDiscoveryTime = 0;
  let lastPoolsCount = 0;
  let cachedRates: Map<string, bigint> | null = null;

  const HF_INTERVAL = 200;
  const LF_INTERVAL = 1000;
  const DISCOVERY_INTERVAL = 60000;
  const MAX_HOPS = ctx.config.routing.maxHops;
  const TIER_CHECK_INTERVAL = 5000;
  let lastTierCheck = 0;

  // Track simulation block for reorg safety
  let lastSimulationBlock = 0;

  ctx.mempoolService.onSignal((signal) => {
    if (signal.type === "new_pool_pending") {
      ctx.logger.info({ txHash: signal.data.txHash }, "New pool deployment detected in mempool! Scheduling rapid discovery.");
      lastDiscoveryTime = 0;
    }
    if (signal.type === "large_swap") {
      ctx.logger.info(
        { pool: signal.data.poolAddress, size: signal.data.estimatedSwapSize.toString(), txHash: signal.data.txHash },
        "Large swap detected in mempool — triggering fast re-simulation",
      );
      lastRefreshTime = 0;
    }
  });

  let cycleWindowStart = Date.now();

  // Start cross-chain scanner in a dedicated background loop if enabled
  if (ctx.config.crossChainArb?.enabled) {
    (async () => {
      ctx.logger.info({}, "Cross-chain scanner background loop started");
      while (ctx.isRunning) {
        try {
          const pools = hasuraPoolsCache ?? ctx.getPools();
          if (pools.length > 0) {
            const polygonPoolStates: PolygonPoolState[] = pools.map((p) => ({
              address: p.address,
              protocol: p.protocol,
              token0: p.token0,
              token1: p.token1,
            }));
            const crossChainRoutes = await ctx.crossChainScanner!.findProfitableRoutes(polygonPoolStates, ctx.stateCache, []);
            for (const route of crossChainRoutes) {
              if (!ctx.isRunning) break;
              ctx.logger.info({ route }, "Cross-chain arb opportunity found");
              const success = await ctx.solverBot!.executeCrossChainArb(route);
              ctx.logger.info({ routeKey: route.flashPool, success }, "Cross-chain arb executed");
            }
          }
        } catch (err) {
          ctx.logger.error({ err }, "Cross-chain arb loop error");
        }
        await sleep(LF_INTERVAL);
      }
    })();
  }

  while (ctx.isRunning) {
    const now = Date.now();
    const startTime = now;

    const cycleWindow = 60000;
    const elapsedCycleWindow = now - cycleWindowStart;
    ctx.metrics.currentCyclesPerMinute = elapsedCycleWindow > 0
      ? Math.round((ctx.metrics.cycles * 60000) / elapsedCycleWindow)
      : 0;
    if (ctx.metrics.currentCyclesPerMinute > ctx.metrics.peakCyclesPerMinute) {
      ctx.metrics.peakCyclesPerMinute = ctx.metrics.currentCyclesPerMinute;
    }
    if (elapsedCycleWindow > cycleWindow) {
      cycleWindowStart = now;
    }

    try {
      ctx.metrics.cycles++;

      if (now - lastTierCheck > TIER_CHECK_INTERVAL) {
        const tier = ctx.tierManager.assess();
        lastTierCheck = now;
        ctx.logger.debug({ tier }, ctx.tierManager.label());
      }

      // Reorg safety check on every cycle
      if (ctx.reorgDetector && lastSimulationBlock > 0) {
        const reorged = await ctx.reorgDetector.checkReorg();
        if (reorged.size > 0) {
          ctx.logger.warn({ reorgedBlocks: [...reorged].join(",") }, "Reorg detected — forcing state refresh");
          const affectedPools = new Set<string>();
          for (const cycle of cachedCycles) {
            for (const edge of cycle.edges) {
              affectedPools.add(edge.poolAddress.toLowerCase());
            }
          }
          // Force re-enumeration on reorg
          lastRefreshTime = 0;
          ctx.reorgDetector.clearReorged();
        }
      }

      let pools = hasuraPoolsCache ?? ctx.getPools();

      if (pools.length === 0 || (now - lastDiscoveryTime > DISCOVERY_INTERVAL && ctx.tierManager.shouldDiscover())) {
        bus?.emit({ type: "pipeline_stage", stage: "DISCOVERY" });
        const graphqlUrl = ctx.config.hasuraUrl;
        const secret = ctx.config.hasuraSecret;
        if (pools.length === 0) {
          ctx.logger.info({}, "No pools — discovering from Hasura");
        } else {
          ctx.logger.info({}, "Polling Hasura for new pools");
        }

        try {
          const discoveryStartTime = Date.now();
          const hasuraPools = await ctx.rpcCircuit.execute(
            () => deps.discoverPoolsFromHasura(graphqlUrl, secret),
            async () => { ctx.logger.warn({}, "Hasura circuit open, returning empty pool list"); return []; },
          );
          const discoveryElapsed = Date.now() - discoveryStartTime;

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
            ctx.logger.info({ discovered: pools.length, durationMs: discoveryElapsed }, "Updated pools from Hasura");
          }
        } catch (e) {
          ctx.logger.warn({ err: e }, "Failed to discover pools from Hasura");
          ctx.metrics.totalErrors++;
          ctx.metrics.lastErrorTime = Date.now();
          ctx.metrics.lastErrorMessage = "Failed to discover pools from Hasura";
        }
      }

      const stateCache = ctx.stateCache;

      if (lastPoolsCount !== pools.length) {
        cachedGraph = deps.buildGraph(pools, stateCache);
        lastPoolsCount = pools.length;
        ctx.graphUpdater?.resetRebuildCounter();
      } else if (ctx.graphUpdater && cachedGraph) {
        // Incremental update: apply new pool states without full rebuild
        for (const pool of pools) {
          const addr = pool.address.toLowerCase();
          const state = stateCache.get(addr);
          if (state) {
            ctx.graphUpdater.applyPoolStateUpdate(cachedGraph, addr, state);
          }
        }
      }

      const shouldReEnumerate = (now - lastRefreshTime) >= LF_INTERVAL;
      const shouldFullRebuild = ctx.graphUpdater?.shouldFullRebuild() ?? true;

      // Force refresh state for ALL active pools via GraphQL + RPC on low-frequency passes
      if (shouldReEnumerate && pools.length > 0) {
        try {
          const graphqlUrl = ctx.config.hasuraUrl;
          const secret = ctx.config.hasuraSecret;
          const gqlCache = await ctx.hasuraCircuit.execute(() => deps.buildStateCacheFromGraphQL(graphqlUrl, secret));
          for (const [addr, state] of gqlCache.entries()) {
            ctx.stateCache.set(addr, state);
          }
          ctx.logger.info({ entries: gqlCache.size }, "State cache refreshed from HyperIndex");
        } catch (err) {
          ctx.logger.warn({ err }, "Failed to refresh state from HyperIndex, falling back to RPC");
        }

        const dummyCycles = pools.map(p => ({ edges: [{ poolAddress: p.address }] } as any));
        await fetchMissingPoolState(ctx, pools, dummyCycles);
      }

      if (shouldReEnumerate || !cachedGraph) {
        bus?.emit({ type: "pipeline_stage", stage: "ENUMERATING" });
        if (shouldFullRebuild || !cachedGraph) {
          cachedGraph = deps.buildGraph(pools, stateCache);
        }
        const enumStartTime = Date.now();
        cachedCycles = deps.enumerateCycles(
          cachedGraph!,
          MAX_HOPS,
          ctx.config.routing.enumerationMaxPaths,
          (key) => ctx.executionService.tracker.getWinRate(key),
        );
        const enumElapsed = Date.now() - enumStartTime;

        lastRefreshTime = now;
        ctx.logger.info(
          {
            pools: pools.length,
            cycles: cachedCycles.length,
            fullRebuild: shouldFullRebuild,
            durationMs: enumElapsed,
          },
          "Graph and cycles re-enumerated",
        );
        const poolsPerProtocol: Record<string, number> = {};
        for (const p of pools) {
          poolsPerProtocol[p.protocol] = (poolsPerProtocol[p.protocol] || 0) + 1;
        }
        bus?.emit({
          type: "graph_built",
          poolCount: pools.length,
          cycleCount: cachedCycles.length,
          poolsPerProtocol,
          maxHops: MAX_HOPS,
        });
      }

      const currentCycles = cachedCycles;

      if (currentCycles.length === 0) {
        bus?.emit({ type: "pipeline_stage", stage: "IDLE" });
        await sleep(HF_INTERVAL);
        continue;
      }

      await fetchMissingPoolState(ctx, pools, currentCycles);

      const gasSnapshot = ctx.gasOracle.getSnapshot();
      if (!gasSnapshot) {
        ctx.logger.debug({}, "Waiting for gas oracle snapshot");
        bus?.emit({ type: "pipeline_stage", stage: "IDLE" });
        await sleep(100);
        continue;
      }

      if (shouldReEnumerate || !cachedRates) {
        cachedRates = computeMaticRates(pools, stateCache);
      }
      const tokenToMaticRates = cachedRates!;

      // Mempool-aware dry run: check pending state before submitting
      if (ctx.dryRunner) {
        await ctx.dryRunner.fetchPendingState();
      }

      bus?.emit({ type: "pipeline_stage", stage: "SIMULATING" });

      const options: PipelineOptions = {
        minProfitMaticWei: ctx.config.execution.minProfitWei,
        gasPriceWei: gasSnapshot.gasPrice,
        tokenToMaticRates,
        slippageBps: ctx.config.execution.slippageBps,
        revertRiskBps: ctx.config.execution.revertRiskBps,
        flashLoanSource: ctx.config.execution.flashLoanSource === "AAVE_V3" ? FlashLoanSource.AAVE_V3 : FlashLoanSource.BALANCER,
        ternarySearchIterations: ctx.config.routing.ternarySearchIterations,
        maxPriceImpactThreshold: ctx.config.routing.maxPriceImpactThreshold,
        onProgress: (current, total, profitable) => {
          if (current % 10 === 0 || current === total) {
            bus?.emit({ type: "simulation_progress", current, total, profitable });
          }
        },
      };

      const simStartTime = Date.now();
      const result = await deps.evaluatePipeline(currentCycles, stateCache, options);
      const simElapsed = Date.now() - simStartTime;

      ctx.metrics.opportunitiesFound += result.profitableCount;

      if (result.attempted > 0) {
        const tier = ctx.tierManager.getCurrent();
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
            isLowFreq: shouldReEnumerate,
            durationMs: simElapsed,
            tier,
          },
          "Cycle assessment complete",
        );

        if (result.profitable.length > 0 && !ctx.tierManager.shouldExecute()) {
          ctx.logger.info({ tier, count: result.profitable.length }, "Execution suppressed by degradation tier");
        } else if (result.profitable.length > 0) {
          const candidates: { candidate: CandidateExecution; profitable: typeof result.profitable[number]; routeKey: string }[] = [];

          for (const profitable of result.profitable) {
            if (!ctx.isRunning) break;

            const routeKey = deps.routeKeyFromEdges(profitable.cycle.edges, profitable.cycle.startToken);
            
            // Format a readable path for the TUI
            const path = profitable.result.tokenPath.map(t => t.slice(0, 6)).join(" -> ");
            const roi = profitable.assessment.roi;

            bus?.emit({ 
              type: "opportunity_found", 
              routeKey, 
              profitWei: profitable.assessment.netProfitAfterGas,
              path,
              roi
            });

            try {
              const candidate = deps.buildExecutionCandidate(
                profitable,
                { executorAddress, fromAddress: executorAddress },
                { slippageBps: Number(options.slippageBps ?? 50n), flashLoanSource: options.flashLoanSource === FlashLoanSource.AAVE_V3 ? "AAVE_V3" : "BALANCER" },
              );

              // Mempool-aware dry run after building candidate
              if (ctx.dryRunner) {
                const dryResult = await ctx.dryRunner.dryRun(candidate, executorAddress);
                if (!dryResult.success) {
                  ctx.logger.warn({ routeKey, reason: dryResult.revertReason }, "Dry-run against pending state failed, skipping");
                  continue;
                }
              }

              candidates.push({ candidate, profitable, routeKey });
            } catch (err) {
              ctx.logger.error({ err, routeKey }, "Failed to build tx for cycle");
              ctx.metrics.totalErrors++;
              ctx.metrics.lastErrorTime = Date.now();
              ctx.metrics.lastErrorMessage = "Failed to build tx for cycle";
            }
          }

          if (candidates.length > 0) {
            bus?.emit({ type: "pipeline_stage", stage: "EXECUTING" });
            const candidateExecs = candidates.map(c => c.candidate);
            const groups = groupCompatibleCandidates(candidateExecs);

            ctx.logger.info(
              { total: candidates.length, groups: groups.length },
              "Executing opportunities in batches",
            );

            for (const group of groups) {
              if (!ctx.isRunning) break;
              ctx.metrics.executionsAttempted += group.length;

              const groupRouteKeys = group.map(c => c.routeKey);
              ctx.logger.info({ groupSize: group.length, routeKeys: groupRouteKeys }, "Executing batch");

              const results = group.length === 1
                ? [await ctx.executionService.execute(group[0])]
                : await ctx.executionService.batchExecute(group);

              for (let i = 0; i < results.length; i++) {
                const execResult = results[i];
                const routeKey = groupRouteKeys[i];

                if (execResult.success) {
                  ctx.metrics.executionsSuccessful++;
                  ctx.logger.info({ txHash: execResult.txHash, routeKey }, "Transaction submitted successfully");
                  bus?.emit({ type: "execution_result", routeKey, success: true, txHash: execResult.txHash });
                } else if (execResult.error === "reverted") {
                  ctx.metrics.executionReverts++;
                  ctx.logger.warn({ routeKey }, "Transaction reverted on chain");
                  bus?.emit({ type: "execution_result", routeKey, success: false, error: "reverted" });
                } else {
                  ctx.metrics.executionsFailed++;
                  ctx.logger.warn({ error: execResult.error, routeKey }, "Execution failed");
                  ctx.metrics.totalErrors++;
                  ctx.metrics.lastErrorTime = Date.now();
                  ctx.metrics.lastErrorMessage = "Execution failed: " + (execResult.error ?? "");
                  bus?.emit({ type: "execution_result", routeKey, success: false, error: execResult.error });
                }
              }
            }
          }
        }
      }

      const elapsed = Date.now() - startTime;
      ctx.metrics.lastCycleDurationMs = elapsed;
      const trackerSummary = ctx.executionService.tracker.summary;
      ctx.metrics.executionReverts = trackerSummary.totalReverts;
      ctx.metrics.trackedRoutes = trackerSummary.trackedRoutes;
      bus?.emit({ type: "heartbeat", elapsedMs: elapsed, cycles: ctx.metrics.cycles, totalErrors: ctx.metrics.totalErrors });
      const payload = buildStatusPayload(ctx.metrics, gasSnapshot.gasPrice, pools.length);
      await writeStatusFile(ctx.config.paths.dataDir, payload).catch(() => {});

      // Track current block for reorg safety
      if (ctx.reorgDetector && ctx.publicClient) {
        try {
          const latest = await ctx.publicClient.getBlock({ blockTag: "latest" });
          if (latest.number && latest.hash) {
            await ctx.reorgDetector.trackBlock(Number(latest.number), latest.hash);
            lastSimulationBlock = Number(latest.number);
          }
        } catch { /* best effort */ }
      }

      const waitMs = Math.max(0, HF_INTERVAL - elapsed);
      bus?.emit({ type: "pipeline_stage", stage: "IDLE" });
      if (waitMs > 0) await sleep(waitMs);
    } catch (err) {
      ctx.logger.error({ err }, "Pass loop error");
      ctx.metrics.totalErrors++;
      ctx.metrics.lastErrorTime = Date.now();
      ctx.metrics.lastErrorMessage = "Pass loop error";
      await sleep(HF_INTERVAL);
    }
  }

  ctx.logger.info({}, "Pass loop exited");
}
