import type { RuntimeContext } from "./boot.ts";
import {
  type FoundCycle,
  findCycles,
  enumerateCycles,
  routeKeyFromEdges,
  type RoutingGraph,
  buildGraph,
  evaluatePipeline,
  type PipelineOptions,
  ArbInstrumenter,
  fetchMissingPoolState,
  computeMaticRates,
  pruneFailedPools,
  averageObscurity,
  type SwapEdge,
} from "../pipeline/index.ts";
import { FlashLoanSource } from "../core/types/execution.ts";
import { groupCompatibleCandidates, type CandidateExecution } from "../services/execution/service.ts";
import {
  discoverPoolsFromHasura,
  buildStateCacheFromGraphQL,
  fetchTokenMetasFromHasura,
  fetchIndexerProgressFromHasura,
} from "../infra/hypersync/hyperindex_graphql.ts";
import { buildExecutionCandidate } from "../services/execution/candidate.ts";
import type { PoolMeta } from "../core/types/pool.ts";
import type { EventBus } from "../tui/events.ts";
import { privateKeyToAccount } from "viem/accounts";
import { buildStatusPayload, writeStatusFile } from "./status_writer.ts";
import type { PassLoopDeps } from "./loop.ts"; // see loop.ts for history of the (now-removed) duplicated runPipeline extraction
import { toBigInt } from "../core/utils/bigint.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * LONG-TAIL / LOW-COMPETITION ARBITRAGE STRATEGY
 *
 * Given minimal infrastructure (no custom nodes, no ultra-low-latency private relays
 * on every path, standard public mempool visibility), the bot is structurally
 * disadvantaged in head-to-head races on the hottest, most liquid pairs.
 *
 * Core thesis:
 * - Hot V3 2-hops on major pairs (Uni/Quick main pools) → extremely competitive,
 *   narrow windows, dominated by latency + private orderflow bots.
 * - Obscure V2 factories, DODO PMM pools, Balancer weighted/stable, many Curve pools,
 *   and complex 3-4 hop cross-protocol paths → much lower bot density.
 *
 * These areas reward:
 *   - Correct multi-AMM modeling (this bot's strength)
 *   - Good historical state (HyperIndex advantage)
 *   - Willingness to take smaller but more reliable edges in thin markets
 *
 * Implementation:
 * - finder.ts applies strong negative adjustments to logWeight for cycles containing
 *   high-obscurity protocols (dfyn/ape/mesh/jet/cometh V2s, DODO, Balancer, Curve, Woofi).
 * - This naturally promotes long-tail cycles into the top candidates that get
 *   deep ternary search + execution attempts.
 * - The effect is amplified for 3/4-hop cycles.
 *
 * Result: the limited simulation and execution budget is preferentially spent where
 * this specific bot has a comparative advantage instead of being wasted losing
 * latency wars on saturated paths.
 *
 * Indexer Interaction:
 * The Envio indexer (hyperindex/) should default to broad discovery.
 * See hyperindex/src/utils/hot_tokens.ts and `INDEXER_HOT_BIAS` env var.
 * Enabling hot-bias in the indexer reduces long-tail pool discovery and should
 * be considered a conservative deviation from this strategy.
 */

const instrumenter = new ArbInstrumenter();

/** LF pass counter for throttling gradual cache expansion (every 10th LF pass) */
let _lfStateRefreshCount = 0;

export const DEFAULT_DEPS: PassLoopDeps = {
  buildGraph,
  findCycles,
  enumerateCycles,
  evaluatePipeline,
  discoverPoolsFromHasura,
  buildStateCacheFromGraphQL,
  fetchTokenMetasFromHasura,
  fetchIndexerProgressFromHasura,
  routeKeyFromEdges,
  buildExecutionCandidate,
  instrumenter,
  averageObscurity, // from finder (re-exported via pipeline); matches optional in PassLoopDeps
};

/**
 * LF orchestration: poll Hasura for new pools (60s cadence).
 * Returns updated pool cache or null if nothing changed.
 */
async function runPoolDiscovery(
  ctx: RuntimeContext,
  deps: PassLoopDeps,
  bus: EventBus | undefined,
  currentPools: PoolMeta[] | null,
  lastDiscoveryTime: number,
  onNewPools: (pools: PoolMeta[]) => void,
): Promise<{ pools: PoolMeta[] | null; lastDiscoveryTime: number }> {
  const now = Date.now();
  const DISCOVERY_INTERVAL = 60000;
  if (
    !(
      currentPools === null ||
      currentPools.length === 0 ||
      (now - lastDiscoveryTime > DISCOVERY_INTERVAL && ctx.tierManager.shouldDiscover())
    )
  ) {
    return { pools: currentPools, lastDiscoveryTime };
  }

  bus?.emit({ type: "pipeline_stage", stage: "DISCOVERY" });
  const graphqlUrl = ctx.config.hasuraUrl;
  const secret = ctx.config.hasuraSecret;
  if (!currentPools || currentPools.length === 0) {
    ctx.logger.info({}, "No pools — discovering from Hasura");
  } else {
    ctx.logger.info({}, "Polling Hasura for new pools");
  }

  const newLastDiscoveryTime = now;
  try {
    const discoveryStartTime = Date.now();
    const hasuraPools = await ctx.rpcCircuit.execute(
      () => deps.discoverPoolsFromHasura(graphqlUrl, secret, ctx.logger),
      async () => {
        ctx.logger.warn({}, "Hasura circuit open, returning empty pool list");
        return [];
      },
    );
    const discoveryElapsed = Date.now() - discoveryStartTime;

    if (hasuraPools.length > 0) {
      const poolLen = currentPools?.length ?? 0;
      if (poolLen > 100 && hasuraPools.length < poolLen / 10) {
        ctx.logger.warn(
          { previous: poolLen, discovered: hasuraPools.length },
          "Suspiciously low number of pools discovered, keeping previous list",
        );
        return { pools: currentPools, lastDiscoveryTime: newLastDiscoveryTime };
      }
      const mapped: PoolMeta[] = hasuraPools.map((p) => ({
        address: p.address as `0x${string}`,
        protocol: p.protocol,
        token0: (p.tokens[0] ?? "") as `0x${string}`,
        token1: (p.tokens[1] ?? "") as `0x${string}`,
        tokens: p.tokens as `0x${string}`[],
        fee: p.fee,
      }));
      onNewPools(mapped);
      ctx.logger.info({ discovered: mapped.length, durationMs: discoveryElapsed }, "Updated pools from Hasura");
      return { pools: mapped, lastDiscoveryTime: newLastDiscoveryTime };
    }
    if (!currentPools) {
      onNewPools([]);
      return { pools: [], lastDiscoveryTime: newLastDiscoveryTime };
    }
  } catch (e) {
    ctx.logger.warn({ err: e }, "Failed to discover pools from Hasura");
    ctx.metrics.totalErrors++;
    ctx.metrics.lastErrorTime = Date.now();
    ctx.metrics.lastErrorMessage = "Failed to discover pools from Hasura";
  }
  return { pools: currentPools, lastDiscoveryTime: newLastDiscoveryTime };
}

/**
 * LF orchestration: refresh state from HyperIndex GraphQL (1s cadence),
 * force-refresh all pools via RPC, and return fresh rates flag.
 */
async function runLfStateRefresh(
  ctx: RuntimeContext,
  deps: PassLoopDeps,
  bus: EventBus | undefined,
  pools: PoolMeta[],
  lastRefreshTime: number,
  currentCycles: FoundCycle[],
): Promise<{ lastRefreshTime: number; lastFullRefreshTime: number; ratesNeedFullRefresh: boolean; updated?: Set<string> }> {
  const now = Date.now();
  const LF_INTERVAL = 1000;
  const stateCacheEmpty = ctx.stateCache.size === 0;
  const lfIntervalElapsed = now - lastRefreshTime >= LF_INTERVAL;
  if (!lfIntervalElapsed && pools.length > 0 && !stateCacheEmpty) {
    return { lastRefreshTime, lastFullRefreshTime: 0, ratesNeedFullRefresh: false, updated: new Set<string>() };
  }

  bus?.emit({ type: "pipeline_stage", stage: "LF_REFRESH" });
  const stateCache = ctx.stateCache;

  try {
    const graphqlUrl = ctx.config.hasuraUrl;
    const secret = ctx.config.hasuraSecret;
    const gqlCache = await ctx.hasuraCircuit.execute(() => deps.buildStateCacheFromGraphQL(graphqlUrl, secret, ctx.logger));
    let newEntries = 0;
    let skippedStale = 0;
    for (const [addr, state] of gqlCache.entries()) {
      if (!stateCache.has(addr)) {
        const s = state as Record<string, unknown>;
        const liq = typeof s.liquidity === "bigint" ? (s.liquidity as bigint) : null;
        const sq = typeof s.sqrtPriceX96 === "bigint" ? (s.sqrtPriceX96 as bigint) : null;
        const r0 = typeof s.reserve0 === "bigint" ? (s.reserve0 as bigint) : null;
        const r1 = typeof s.reserve1 === "bigint" ? (s.reserve1 as bigint) : null;
        // Skip Hasura states that are clearly stale (pool-creation snapshot with zero values).
        // They would block gradual RPC refresh for that pool.
        const staleV3 = liq !== null && liq === 0n;
        const staleV2 = r0 !== null && r1 !== null && r0 === 0n && r1 === 0n;
        if (staleV3 || staleV2) {
          skippedStale++;
          continue;
        }
        stateCache.set(addr, state);
        newEntries++;
      }
    }
    ctx.logger.debug({ entries: gqlCache.size, newEntries, skippedStale }, "State and TokenMeta refreshed from HyperIndex");

    // New: lightweight progress signal from the block handler (see hyperindex/src/handlers/progress.ts)
    const progress = await ctx.hasuraCircuit.execute(() => deps.fetchIndexerProgressFromHasura(graphqlUrl, secret, ctx.logger));
    if (progress) {
      ctx.logger.debug(
        { chainId: progress.chainId, lastProcessedBlock: progress.lastProcessedBlock },
        "IndexerProgress from block handler",
      );
      // Wire to monitor so TUI, logs, lag calc, and health checks see accurate synced/lag
      // (the getIndexedHeight provider is best-effort; this pushes on every LF).
      if (ctx.hyperIndexMonitor) {
        ctx.hyperIndexMonitor.updateSyncedBlock(progress.lastProcessedBlock);
      }
    }
  } catch (err) {
    // Suppress repeated "circuit open" noise: only warn on the first open event; debug thereafter.
    // The circuit can stay open for up to 60s while logging every 1s LF tick = ~60 identical lines.
    const isCircuitOpenError = err instanceof Error && err.message.includes("Circuit breaker") && err.message.includes("is open");
    if (isCircuitOpenError && ctx.hasuraCircuit.getState() === "open") {
      ctx.logger.debug({ err }, "Hasura circuit open — skipping HyperIndex state refresh (RPC fallback active)");
    } else {
      ctx.logger.warn({ err }, "Failed to refresh state from HyperIndex, falling back to RPC");
    }
  }

  // Fetch state for pools in current cycles that are missing from cache.
  // Avoid force-refresh of ALL pools (47k+) which blocks the pipeline.
  // On first boot, any forceRefresh that IS needed is handled by the pre-fetch path.
  const stateClient = ctx.stateClient ?? ctx.publicClient;
  const updated = await fetchMissingPoolState(stateClient, stateCache, pools, currentCycles, false);

  // Bootstrap: on first LF pass, pre-fetch V2/V3 state for a sensible number of pools.
  // This lets rate propagation reach thousands of tokens on the very first pass
  // instead of waiting for gradual state accumulation through pre-fetch cycles.
  // BROADER: larger limit + prioritize pools touching major tokens (WMATIC + stables/WETH etc)
  // so computeMaticRates (which seeds those majors) can propagate rates to far more tokens
  // immediately. This increases # of rateSafeCycles, reduces noRate %, and surfaces more
  // (and better) long-tail opportunities instead of only marginal hot V2 pairs.
  if (stateCacheEmpty) {
    const MAX_BOOTSTRAP_POOLS = 8000;
    const stateAddrSet = new Set<string>();
    for (const addr of stateCache.keys()) stateAddrSet.add(addr);
    const missingPools = pools.filter((p) => !stateAddrSet.has(p.address.toLowerCase()));

    // Prioritize majors so initial rate graph is well-connected (directly attacks high noRate
    // and low coverage that starves assessment of rateSafe cycles).
    const MAJOR_TOKENS = new Set([
      "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270", // WMATIC
      "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", // USDC
      "0x2791bca1f2de4661ed88a30c99a7a9449aa84174", // USDC.e (old)
      "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", // USDT
      "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619", // WETH
      "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063", // DAI
      "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", // WBTC
    ].map((t) => t.toLowerCase()));

    const touchesMajor = (p: PoolMeta) => {
      const ts = (p.tokens ?? [p.token0, p.token1]).map((t) => t.toLowerCase());
      return ts.some((t) => MAJOR_TOKENS.has(t));
    };

    const prioritized = [...missingPools].sort((a, b) => (touchesMajor(b) ? 1 : 0) - (touchesMajor(a) ? 1 : 0));
    const toBootstrap = prioritized.slice(0, MAX_BOOTSTRAP_POOLS);

    if (toBootstrap.length > 0) {
      const majorCount = prioritized.filter(touchesMajor).length;
      ctx.logger.info({ missingPools: toBootstrap.length, majorConnected: majorCount }, "Bootstrap: pre-fetching V2/V3 state for rate propagation");
      // Force-refresh the critical (major-connected) pools; remaining ~37k accumulate gradually.
      const seedUpdated = await fetchMissingPoolState(stateClient, stateCache, toBootstrap, [], true);
      for (const addr of seedUpdated) updated.add(addr);
      ctx.logger.info({ seedFetched: seedUpdated.size, stillMissing: toBootstrap.length - seedUpdated.size }, "Bootstrap fetch complete");
    }
  }

  // Gradual cache expansion: every 10th LF pass, force-refresh a batch of uncached pools
  // until the cache reaches target size (~75% of total pools). Uses stateClient (dedicated RPC)
  // so it doesn't compete with the hot path.
  _lfStateRefreshCount++;
  const CACHE_TARGET = 30000;
  if (!stateCacheEmpty && stateCache.size < CACHE_TARGET && _lfStateRefreshCount % 10 === 0) {
    const EXPANSION_BATCH = 2000;
    const uncached = pools.filter((p) => !stateCache.has(p.address.toLowerCase()));
    if (uncached.length > 0) {
      const batch = uncached.slice(0, EXPANSION_BATCH);
      const expanded = await fetchMissingPoolState(stateClient, stateCache, batch, [], true);
      if (expanded.size > 0) {
        for (const addr of expanded) updated.add(addr);
        ctx.logger.info(
          { expanded: expanded.size, totalCached: stateCache.size, remaining: uncached.length - expanded.size },
          "Gradual cache expansion batch complete",
        );
      }
    }
  }

  return { lastRefreshTime: now, lastFullRefreshTime: now, ratesNeedFullRefresh: true, updated };
}

/**
 * Filter pools for graph building, rebuild graph, enumerate cycles.
 * Returns updated graph, cycle list, and whether enumeration actually ran.
 */
async function runEnumerationPhase(
  ctx: RuntimeContext,
  deps: PassLoopDeps,
  bus: EventBus | undefined,
  pools: PoolMeta[],
  stateCache: Map<string, Record<string, unknown>>,
  cachedGraph: RoutingGraph | null,
  cachedCycles: FoundCycle[],
  lastRefreshTime: number,
): Promise<{ graph: RoutingGraph | null; cycles: FoundCycle[]; lastRefreshTime: number; didEnumerate: boolean }> {
  const now = Date.now();
  const MAX_HOPS = ctx.config.routing.maxHops;
  const LF_INTERVAL = 1000;
  const shouldReEnumerate = now - lastRefreshTime >= LF_INTERVAL || !cachedGraph || cachedCycles.length === 0;

  if (!shouldReEnumerate) {
    return { graph: cachedGraph, cycles: cachedCycles, lastRefreshTime, didEnumerate: false };
  }

  bus?.emit({ type: "pipeline_stage", stage: "ENUMERATING" });

  const filteredPools = pools.filter((p) => {
    const protocol = p.protocol.toLowerCase();
    const addr = p.address.toLowerCase();
    if (protocol.includes("v3") || protocol.includes("v4") || protocol.includes("elastic")) {
      const state = stateCache.get(addr);
      if (!state) return false;
      const rawLiq = (state as Record<string, unknown>).liquidity ?? 0;
      const liq = toBigInt(rawLiq, 0n);
      if (liq < ctx.config.execution.minLiquidityV3Rate) {
        return false;
      }
    }
    return true;
  });

  ctx.logger.info(
    { total: pools.length, filtered: filteredPools.length, removed: pools.length - filteredPools.length },
    "Pools filtered for graph building",
  );

  const graph = deps.buildGraph(filteredPools, stateCache);

  bus?.emit({
    type: "graph_stats",
    poolCount: pools.length,
    protocolBreakdown: pools.reduce(
      (acc, p) => {
        const proto = p.protocol.split("_")[0] ?? p.protocol;
        acc[proto] = (acc[proto] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    ),
    edgeCount: graph.adjacency.size,
    cachedCount: stateCache.size,
  });

  const enumStartTime = Date.now();
  const cycles = deps.enumerateCycles(graph, MAX_HOPS, ctx.config.routing.enumerationMaxPaths, (key) =>
    ctx.executionService.tracker.getWinRate(key),
  );
  const enumElapsed = Date.now() - enumStartTime;

  const cyclesByHop: Record<number, number> = {};
  for (const cycle of cycles) {
    cyclesByHop[cycle.hopCount] = (cyclesByHop[cycle.hopCount] ?? 0) + 1;
  }
  bus?.emit({
    type: "cycles_enumerated",
    total: cycles.length,
    cyclesByHop,
    elapsedMs: enumElapsed,
  });

  ctx.logger.info(
    { pools: pools.length, filtered: filteredPools.length, cycles: cycles.length, durationMs: enumElapsed },
    "Graph and cycles re-enumerated",
  );

  return { graph, cycles, lastRefreshTime: now, didEnumerate: true };
}

export async function runPassLoop(ctx: RuntimeContext, deps: PassLoopDeps = DEFAULT_DEPS, bus?: EventBus): Promise<void> {
  const executorAddress = ctx.config.execution.executorAddress;
  const operatorAccount = privateKeyToAccount(ctx.config.execution.privateKey as `0x${string}`);
  const operatorAddress = operatorAccount.address;

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
          headTriggered = true;
          lastHeadTime = Date.now();
          ctx.pendingStateOverlay?.clear();
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
  let lastFullRefreshTime = 0;
  let lastDiscoveryTime = 0;
  let cachedRates: Map<string, bigint> | null = null;
  let cachedMetas: Map<string, { decimals: number }> | null = null;
  // Rate refresh intent flags — set by LF / pre-fetch paths, consumed by single ensureRates block
  let ratesNeedFullRefresh = false;
  let pendingFocusTokens: Set<string> | null = null;
  let isLfPass = false;

  const HF_INTERVAL = 200;
  const LF_INTERVAL = 1000;
  const TIER_CHECK_INTERVAL = 5000;
  let preFetchCounter = 0;
  let lastTierCheck = 0;

  const recentRouteTimestamps = new Map<string, number>();
  const ROUTE_COOLDOWN_MS = 5000;

  // Block-aligned HF timing: when newHead arrives from Chainstack WS,
  // the sleep between cycles is shortened to ~50ms for immediate re-evaluation.
  // Falls back to normal 200ms polling after HEAD_TIMEOUT_MS without a head.
  let headTriggered = false;
  let lastHeadTime = 0;
  const HEAD_TIMEOUT_MS = 3000;

  ctx.mempoolService.onSignal((signal) => {
    if (signal.type === "new_pool_pending") {
      ctx.logger.info({ txHash: signal.data.txHash }, "New pool deployment detected in mempool! Scheduling rapid discovery.");
      bus?.emit({
        type: "mempool_pending_swap",
        poolPath: signal.data.factoryAddress,
        value: 0n,
        txHash: signal.data.txHash,
      });
      lastDiscoveryTime = 0;
    }
    if (signal.type === "large_swap") {
      ctx.logger.info(
        { pool: signal.data.poolAddress, size: signal.data.estimatedSwapSize.toString(), txHash: signal.data.txHash },
        "Large swap detected in mempool — triggering fast re-simulation",
      );
      bus?.emit({
        type: "mempool_pending_swap",
        poolPath: signal.data.poolAddress,
        value: signal.data.estimatedSwapSize,
        txHash: signal.data.txHash,
      });
      lastRefreshTime = 0;
    }
  });

  let cycleWindowStart = Date.now();
  let lastReorgCheck = 0;

  while (ctx.isRunning) {
    const now = Date.now();
    const startTime = now;
    isLfPass = false;

    const cycleWindow = 60000;
    const elapsedCycleWindow = now - cycleWindowStart;
    ctx.metrics.currentCyclesPerMinute = elapsedCycleWindow > 0 ? Math.round((ctx.metrics.cycles * 60000) / elapsedCycleWindow) : 0;
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
        // Prune stale route cooldown entries
        for (const [key, ts] of recentRouteTimestamps) {
          if (now - ts > ROUTE_COOLDOWN_MS * 2) recentRouteTimestamps.delete(key);
        }
        // Also prune the fetcher failed-pool tracker (prevents slow memory growth)
        pruneFailedPools(now);
      }

      // Reorg safety + block tracking moved out of HF (200ms) hot path.
      // Per AGENTS.md: getBlock sparingly in HF. WS newHead + LF (1s) are the triggers.
      // Heavy serial getBlock calls inside checkReorg were killing HF latency/RPC budget.

      const stateCache = ctx.stateCache;
      const updatedPools = new Set<string>();

      // Stage 1: Pool discovery (60s cadence)
      {
        const result = await runPoolDiscovery(ctx, deps, bus, hasuraPoolsCache, lastDiscoveryTime, (newPools) => {
          hasuraPoolsCache = newPools;
          cachedGraph = deps.buildGraph(newPools, stateCache);
          ctx.graphUpdater?.resetRebuildCounter();
          if (newPools && newPools.length > 0) {
            ctx.mempoolService.setKnownPools(newPools.map((p) => p.address));
          }
        });
        hasuraPoolsCache = result.pools;
        lastDiscoveryTime = result.lastDiscoveryTime;
      }

      // Stage 2: LF state refresh from HyperIndex + RPC force-refresh (1s cadence)
      {
        const lfResult = await runLfStateRefresh(ctx, deps, bus, hasuraPoolsCache ?? [], lastRefreshTime, cachedCycles ?? []);
        if (lfResult.updated) {
          for (const addr of lfResult.updated) updatedPools.add(addr);
        }
        if (lfResult.ratesNeedFullRefresh) {
          lastRefreshTime = lfResult.lastRefreshTime;
          lastFullRefreshTime = lfResult.lastFullRefreshTime;
          ratesNeedFullRefresh = true;
          pendingFocusTokens = null;
        }
      }

      // Stage 3: Filter pools, rebuild graph, enumerate cycles
      {
        const enumResult = await runEnumerationPhase(
          ctx,
          deps,
          bus,
          hasuraPoolsCache ?? [],
          stateCache,
          cachedGraph,
          cachedCycles,
          lastRefreshTime,
        );
        cachedGraph = enumResult.graph;
        cachedCycles = enumResult.cycles;
        lastRefreshTime = enumResult.lastRefreshTime;
        isLfPass = enumResult.didEnumerate;
      }

      // Incremental graph update on HF cycles (no discovery, no LF — just new pool states)
      // Now optimized to only update "dirty" pools successfully refreshed in Stage 2 or Pre-fetch
      if (ctx.graphUpdater && cachedGraph && !ratesNeedFullRefresh && updatedPools.size > 0) {
        for (const addr of updatedPools) {
          const state = stateCache.get(addr);
          if (state) {
            ctx.graphUpdater.applyPoolStateUpdate(cachedGraph, addr, state);
          }
        }
      }

      // Stage 4: Re-check whether cachedMetas should be refreshed (done inside LF, may be needed for HF)
      if (!cachedMetas && (hasuraPoolsCache?.length ?? 0) > 0) {
        try {
          cachedMetas = await deps.fetchTokenMetasFromHasura(ctx.config.hasuraUrl, ctx.config.hasuraSecret, ctx.logger);
        } catch {
          // Non-critical; will retry on next LF
        }
      }

      const currentCycles = cachedCycles;

      if (currentCycles.length === 0) {
        bus?.emit({ type: "pipeline_stage", stage: "IDLE" });
        await sleep(HF_INTERVAL);
        continue;
      }

      // High-frequency pre-fetch: Only for pools in current cycles
      // Skip if we just did a full refresh in the same pass
      preFetchCounter++;
      if (lastFullRefreshTime !== now && preFetchCounter % 5 === 0) {
        bus?.emit({ type: "pipeline_stage", stage: "PRE_FETCH" });
        const justUpdated = await fetchMissingPoolState(ctx.stateClient ?? ctx.publicClient, stateCache, hasuraPoolsCache ?? [], currentCycles, false);
        if (justUpdated.size > 0) {
          for (const addr of justUpdated) updatedPools.add(addr);
        }

        // Build focus tokens from the pools we actually refreshed this round.
        // O(1) lookup via address map instead of O(N) pools.find() per updated address.
        const focusTokens = new Set<string>();
        if (justUpdated.size > 0) {
          const poolByAddr = new Map<string, `0x${string}`[] | undefined>();
          for (const p of hasuraPoolsCache ?? []) poolByAddr.set(p.address.toLowerCase(), p.tokens);
          for (const addr of justUpdated) {
            const tokens = poolByAddr.get(addr);
            if (tokens) {
              for (const t of tokens) focusTokens.add(t.toLowerCase());
            }
          }
        }

        // Signal incremental rate update for the consolidated ensureRates block below.
        // Using seed + focus gives cheap dirty-token propagation (P3 optimization).
        pendingFocusTokens = focusTokens.size > 0 ? focusTokens : null;
        if (!cachedMetas) {
          cachedMetas = await deps.fetchTokenMetasFromHasura(ctx.config.hasuraUrl, ctx.config.hasuraSecret, ctx.logger);
        }
      }

      // === INDEXER LAG DETECTION (early, for graceful degradation decisions) ===
      const INDEXER_LAG_THRESHOLD_BLOCKS = 5000; // ~2+ hours on Polygon
      let currentIndexerLag = 0;
      const hiStatusForLag = ctx.hyperIndexMonitor ? ctx.hyperIndexMonitor.getLastStatus() : undefined;
      if (hiStatusForLag && hiStatusForLag.remote > 0 && hiStatusForLag.synced > 0) {
        currentIndexerLag = Math.max(0, hiStatusForLag.remote - hiStatusForLag.synced);
        if (currentIndexerLag > INDEXER_LAG_THRESHOLD_BLOCKS) {
          ctx.logger.warn(
            {
              lag: currentIndexerLag,
              threshold: INDEXER_LAG_THRESHOLD_BLOCKS,
              synced: hiStatusForLag.synced,
              remote: hiStatusForLag.remote,
            },
            "High indexer lag detected — entering degraded mode (reduced concurrency, higher profit floor)",
          );
        }
      }

      const gasSnapshot = ctx.gasOracle.getSnapshot();
      if (!gasSnapshot) {
        ctx.logger.debug({}, "Waiting for gas oracle snapshot");
        bus?.emit({ type: "pipeline_stage", stage: "IDLE" });
        await sleep(100);
        continue;
      }

      bus?.emit({ type: "gas_snapshot", gasPrice: gasSnapshot.gasPrice });

      // Single consolidated rate computation point — guarantees at most one computeMaticRates call per pass.
      // Priority: full refresh (LF) > incremental focus update (pre-fetch) > safety net.
      bus?.emit({ type: "pipeline_stage", stage: "RATES" });
      if (ratesNeedFullRefresh) {
        // Seed from previous cached rates even on "full" refresh. This prevents coverage
        // from dropping back to a few hundred on every LF tick (the bare compute only
        // propagates from states present + WMATIC seeds). New stateCache entries will
        // still expand the graph during the call. The subsequent cycle-focus boost
        // will then only log "boosted" on *actual* growth.
        cachedRates = computeMaticRates(hasuraPoolsCache ?? [], stateCache, ctx.logger, {
          minLiquidityV3: ctx.config.execution.minLiquidityV3Rate,
          seedRates: cachedRates ?? undefined,
        });
        ratesNeedFullRefresh = false;
      } else if (pendingFocusTokens && cachedRates) {
        cachedRates = computeMaticRates(hasuraPoolsCache ?? [], stateCache, ctx.logger, {
          minLiquidityV3: ctx.config.execution.minLiquidityV3Rate,
          seedRates: cachedRates,
          focusTokens: pendingFocusTokens,
        });
        pendingFocusTokens = null;
      } else if (!cachedRates) {
        cachedRates = computeMaticRates(hasuraPoolsCache ?? [], stateCache, ctx.logger, {
          minLiquidityV3: ctx.config.execution.minLiquidityV3Rate,
        });
      }
      let tokenToMaticRates = cachedRates!;

      // Focused rate boost using the *current graph's cycles* (available early).
      // Always prioritize the tokens in the current graph batch for propagation + targeted sweep.
      // This ensures rateSafe/grossMatic see the best possible rates for exactly the cycles
      // we're assessing this pass (directly addresses persistent low rates in surfacing even
      // after polls). Log at info when it grows the set.
      {
        const focus = new Set<string>();
        for (const c of currentCycles) {
          focus.add(c.startToken.toLowerCase());
          for (const e of c.edges) {
            focus.add(e.tokenIn.toLowerCase());
            focus.add(e.tokenOut.toLowerCase());
          }
        }
        const before = tokenToMaticRates.size;
        if (focus.size > 0) {
          const boosted = computeMaticRates(hasuraPoolsCache ?? [], stateCache, ctx.logger, {
            minLiquidityV3: ctx.config.execution.minLiquidityV3Rate,
            seedRates: tokenToMaticRates,
            focusTokens: focus,
          });
          cachedRates = boosted;
          tokenToMaticRates = boosted;
          if (boosted.size > before) {
            ctx.logger.info({ rates: tokenToMaticRates.size, focus: focus.size }, "Rate coverage boosted with assessment focus");
          }
        }
      }

      // Filter out quarantined routes before simulation to avoid repetitive noise.
      // Prefer cycle.id (pre-computed by enumerateCycles when win-rate scoring is active)
      // to avoid redundant O(N log N) routeKeyFromEdges work.
      const filteredCycles = currentCycles.filter((cycle) => {
        const routeKey = cycle.id ?? deps.routeKeyFromEdges(cycle.edges, cycle.startToken);
        return !ctx.executionService.isQuarantined(routeKey);
      });

      if (filteredCycles.length === 0) {
        bus?.emit({ type: "pipeline_stage", stage: "IDLE" });
        await sleep(HF_INTERVAL);
        continue;
      }

      // (Focused rate boost already applied earlier using currentCycles + assessment tokens;
      // see the block right after the consolidated computeMaticRates. This helps rateSafe
      // and profit assessment for the exact cycles in this pass.)

      // Mempool-aware dry run: check pending state before submitting
      if (ctx.dryRunner) {
        await ctx.dryRunner.fetchPendingState();
      }

      bus?.emit({ type: "pipeline_stage", stage: "SIMULATING" });

      // Apply graceful degradation if indexer lag is high
      const isDegraded = currentIndexerLag > INDEXER_LAG_THRESHOLD_BLOCKS;
      const effectiveConcurrency = isDegraded
        ? Math.max(10, Math.floor((ctx.config.routing.concurrency ?? 50) * 0.4))
        : ctx.config.routing.concurrency;
      const effectiveMinProfit = isDegraded
        ? ctx.config.execution.minProfitWei * 2n // Be much more selective when data is stale
        : ctx.config.execution.minProfitWei;

      const options: PipelineOptions = {
        minProfitMaticWei: effectiveMinProfit,
        gasPriceWei: gasSnapshot.gasPrice,
        tokenToMaticRates,
        tokenMetas: cachedMetas ?? undefined,
        slippageBps: ctx.config.execution.slippageBps,
        revertRiskBps: ctx.config.execution.revertRiskBps,
        flashLoanSource: ctx.config.execution.flashLoanSource === "AAVE_V3" ? FlashLoanSource.AAVE_V3 : FlashLoanSource.BALANCER,
        ternarySearchIterations: ctx.config.routing.ternarySearchIterations,
        maxPriceImpactThreshold: ctx.config.routing.maxPriceImpactThreshold,
        concurrency: effectiveConcurrency,
        roiSafetyCap: ctx.config.execution.roiSafetyCap,
        logger: ctx.logger,
        onProgress: (current, total, profitable) => {
          if (current % 10 === 0 || current === total) {
            bus?.emit({ type: "simulation_progress", current, total, profitable });
          }
        },
      };

      if (isDegraded) {
        ctx.logger.debug(
          { effectiveConcurrency, effectiveMinProfit: effectiveMinProfit.toString() },
          "Running in indexer-lag degraded mode",
        );
      }

      // Focus expensive simulation on cycles where the *start token* has a rate (flash principal is valued; profit asserted in startToken units).
      // Intermediates without rates contribute 0 to gross (conservative) and extreme checks are skipped for them.
      // This allows more of the graph to be evaluated as rate coverage grows slowly from WMATIC bootstrap + stateCache.
      const rateSafeCycles = filteredCycles.filter((cycle) => {
        const startRate = tokenToMaticRates.get(cycle.startToken.toLowerCase()) ?? 0n;
        return startRate > 0n;
      });

      if (rateSafeCycles.length === 0 && filteredCycles.length > 0) {
        ctx.logger.debug({ totalFiltered: filteredCycles.length, rates: tokenToMaticRates.size }, "No rate-covered cycles this pass (coverage still growing)");
      }

      const simStartTime = Date.now();
      const result = await deps.evaluatePipeline(rateSafeCycles, stateCache, options, ctx.pendingStateOverlay);
      const simElapsed = Date.now() - simStartTime;

      ctx.metrics.opportunitiesFound += result.profitableCount;

      if (result.attempted > 0) {
        const tier = ctx.tierManager.getCurrent();
        ctx.logger.debug(
          {
            attempted: result.attempted,
            simulated: result.simulated,
            pruned: result.pruned,
            noRate: result.noRate,
            profitable: result.profitableCount,
            maxGrossMatic:
              result.maxGrossProfitMatic !== undefined ? (result.maxGrossProfitMatic / 10n ** 15n).toString() + "mMATIC" : "N/A",
            rates: tokenToMaticRates.size,
            cache: stateCache.size,
            isLowFreq: isLfPass,
            durationMs: simElapsed,
            tier,
          },
          "Cycle assessment complete",
        );

        if (result.profitableCount > 0) {
          ctx.logger.info(
            {
              profitable: result.profitableCount,
              maxGrossMatic: result.maxGrossProfitMatic !== undefined ? (result.maxGrossProfitMatic / 10n ** 15n).toString() + "mMATIC" : "N/A",
              rates: tokenToMaticRates.size,
            },
            "Assessment found profitable candidates (pre-filter; may skip on cooldown/dry/quarantine)",
          );
        } else if (result.noRate > Math.floor(result.attempted * 0.8) && result.attempted > 50) {
          ctx.logger.info(
            {
              attempted: result.attempted,
              noRate: result.noRate,
              rates: tokenToMaticRates.size,
              cache: stateCache.size,
            },
            "Assessment: very high noRate fraction (rate propagation/coverage issue?)",
          );
        }

        if (result.profitable.length > 0 && !ctx.tierManager.shouldExecute()) {
          ctx.logger.debug({ tier, count: result.profitable.length }, "Execution suppressed by degradation tier");
        } else if (result.profitable.length > 0) {
          const candidates: { candidate: CandidateExecution; profitable: (typeof result.profitable)[number]; routeKey: string }[] = [];

          for (const profitable of result.profitable) {
            if (!ctx.isRunning) break;

            const routeKey = profitable.cycle.id ?? deps.routeKeyFromEdges(profitable.cycle.edges, profitable.cycle.startToken);

            const lastSubmit = recentRouteTimestamps.get(routeKey);
            if (lastSubmit && now - lastSubmit < ROUTE_COOLDOWN_MS) {
              ctx.logger.debug({ routeKey, lastSubmit, now }, "Route recently submitted, skipping cooldown");
              continue;
            }
            recentRouteTimestamps.set(routeKey, now);

            // Format a readable path for the TUI
            const path = profitable.result.tokenPath.map((t) => t.slice(0, 6)).join(" -> ");
            const roi = Number(profitable.assessment.roi);
            const isNearMiss = roi > 950_000 && roi < 1_000_000;

            if (isNearMiss) {
              ctx.logger.debug(
                {
                  routeKey,
                  roi,
                  profit: profitable.assessment.netProfitAfterGas.toString(),
                  path: profitable.result.tokenPath.join(" -> "),
                },
                "Near-miss opportunity identified",
              );
            }

            if (!profitable.result.profitable) continue;

            // Capture full simulation trace for debugging
            deps.instrumenter.captureTrace(routeKey, profitable.result, stateCache);

            bus?.emit({
              type: "opportunity_found",
              routeKey,
              profitWei: profitable.assessment.netProfitAfterGas,
              path,
              roi: profitable.assessment.roi,
            });

            try {
              // Low-competition relaxation:
              // In obscure/long-tail paths the edge tends to persist longer and competition
              // is lower, so we can afford slightly more slippage/revert risk to capture
              // opportunities that stricter parameters would drop.
              const avgObs = deps.averageObscurity ? deps.averageObscurity(profitable.cycle.edges) : 0;
              const obscurityRelax = Math.min(1.0, Math.max(0, avgObs)) * 25; // up to +25 bps on high-obscurity

              const candidate = deps.buildExecutionCandidate(
                profitable,
                { executorAddress, fromAddress: executorAddress },
                {
                  slippageBps: Number(options.slippageBps ?? 400n) + Math.floor(obscurityRelax) + 500, // bumped further (+400 default / +500) based on 93.6s tailer data (K at call 3 persisted even after previous bump and "Starting" of new main with higher slip; even smaller minOut for V2 swaps to give K more headroom on thin/pending reserves with high gas ~445 (assert still guards net)
                  flashLoanSource: options.flashLoanSource === FlashLoanSource.AAVE_V3 ? "AAVE_V3" : "BALANCER",
                  stateCache,
                },
              );

              // Mempool-aware dry run after building candidate
              if (ctx.dryRunner) {
                const dryRun = await ctx.dryRunner.dryRun(candidate, operatorAddress);
                if (!dryRun.success) {
                  ctx.logger.warn(
                    {
                      routeKey,
                      reason: dryRun.revertReason || dryRun.error,
                      revertData: dryRun.revertData,
                      calldata: candidate.calldata,
                      target: candidate.targetAddress,
                      profitable: {
                        roi: profitable.assessment.roi,
                        profit: profitable.assessment.netProfitAfterGas.toString(),
                        pools: profitable.cycle.edges.map((e) => e.poolAddress),
                        protocols: profitable.cycle.edges.map((e) => e.protocol),
                      },
                    },
                    "Dry-run against pending state failed, skipping",
                  );
                  // Dump full calldata for AI debug (arb-tx-tools sim) - useful when running `bun run tui`
                  // or headless to feed simulator/abicoder for exact re-runs of failing arbs.
                  try {
                    const { appendFileSync } = await import("node:fs");
                    const dump = JSON.stringify({ ts: Date.now(), routeKey, calldata: candidate.calldata, target: candidate.targetAddress, revertData: dryRun.revertData }) + "\n";
                    appendFileSync("data/failing-calldata.ndjson", dump);
                  } catch {}
                  ctx.executionService.getQuarantineManager().add(routeKey, dryRun.revertReason || dryRun.error);
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
            const candidateExecs = candidates.map((c) => c.candidate);
            const groups = groupCompatibleCandidates(candidateExecs);

            ctx.logger.info({ total: candidates.length, groups: groups.length }, "Executing opportunities in batches");

            for (const group of groups) {
              if (!ctx.isRunning) break;
              ctx.metrics.executionsAttempted += group.length;

              const groupRouteKeys = group.map((c) => c.routeKey);
              ctx.logger.info({ groupSize: group.length, routeKeys: groupRouteKeys }, "Executing batch");

              // Emit submitted event for each candidate in the group
              for (const routeKey of groupRouteKeys) {
                bus?.emit({ type: "execution_submitted", routeKey });
              }

              for (const c of candidates) {
                bus?.emit({
                  type: "execution_attempt",
                  protocolPath: c.profitable.cycle.edges.map((e: SwapEdge) => e.protocol).join("→"),
                  hopCount: c.profitable.cycle.hopCount,
                  expectedProfit: c.profitable.assessment.netProfitAfterGas,
                  txHash: undefined,
                });
              }

              const results =
                group.length === 1 ? [await ctx.executionService.execute(group[0])] : await ctx.executionService.batchExecute(group);

              for (let i = 0; i < results.length; i++) {
                const execResult = results[i];
                const routeKey = groupRouteKeys[i];
                const execDetails = candidates.find((c) => c.routeKey === routeKey);
                const protocolPath = execDetails?.profitable.cycle.edges.map((e: SwapEdge) => e.protocol).join("→");
                const hopCount = execDetails?.profitable.cycle.hopCount;

                if (execResult.success) {
                  ctx.metrics.executionsSuccessful++;
                  ctx.logger.info({ txHash: execResult.txHash, routeKey }, "Transaction submitted successfully");

                  // Try to get actual profit from tracker if available
                  const tracked = ctx.executionService.tracker.getRecentRecords(10).find((e) => e.txHash === execResult.txHash);
                  const profitWei = tracked
                    ? tracked.profit
                    : candidates.find((c) => c.routeKey === routeKey)?.profitable.assessment.netProfitAfterGas;

                  bus?.emit({
                    type: "execution_result",
                    routeKey,
                    success: true,
                    txHash: execResult.txHash,
                    profitWei,
                    traceMessages: execResult.traceMessages,
                    protocolPath,
                    hopCount,
                  });
                } else if (execResult.error === "reverted") {
                  ctx.metrics.executionReverts++;
                  ctx.logger.warn({ routeKey }, "Transaction reverted on chain");
                  bus?.emit({
                    type: "execution_result",
                    routeKey,
                    success: false,
                    error: "reverted",
                    traceMessages: execResult.traceMessages,
                    protocolPath,
                    hopCount,
                  });
                } else {
                  ctx.metrics.executionsFailed++;
                  ctx.logger.warn({ error: execResult.error, routeKey }, "Execution failed");
                  ctx.metrics.totalErrors++;
                  ctx.metrics.lastErrorTime = Date.now();
                  ctx.metrics.lastErrorMessage = "Execution failed: " + (execResult.error ?? "");
                  bus?.emit({
                    type: "execution_result",
                    routeKey,
                    success: false,
                    error: execResult.error,
                    traceMessages: execResult.traceMessages,
                    protocolPath,
                    hopCount,
                  });
                }
              }
            }
          }
        }
      }

      const elapsed = Date.now() - startTime;
      ctx.metrics.lastCycleDurationMs = elapsed;

      // Minimal HF budget instrumentation (P2 item from debug pass).
      // After previous purges (reorg/getBlock moved out), the loop should comfortably stay < 160 ms.
      // If we ever regress and start doing heavy work in the 200 ms path, this will scream.
      const HF_BUDGET_MS = 160;
      if (elapsed > HF_BUDGET_MS) {
        ctx.logger.debug(
          { elapsed, budget: HF_BUDGET_MS, cycles: ctx.metrics.cycles },
          "HF cycle exceeded budget — possible hot-path regression (reorg, heavy RPC, or expensive simulation)",
        );
      }
      if (!ctx.metrics.maxHotPathDurationMs || elapsed > ctx.metrics.maxHotPathDurationMs) {
        ctx.metrics.maxHotPathDurationMs = elapsed;
      }
      const trackerSummary = ctx.executionService.tracker.summary;
      ctx.metrics.executionReverts = trackerSummary.totalReverts;
      ctx.metrics.trackedRoutes = trackerSummary.trackedRoutes;
      bus?.emit({
        type: "heartbeat",
        elapsedMs: elapsed,
        cycles: ctx.metrics.cycles,
        totalErrors: ctx.metrics.totalErrors,
        indexerLag: currentIndexerLag,
        gasPrice: gasSnapshot?.gasPrice,
        rpcConnected: !!ctx.publicClient,
        hasuraConnected: !!ctx.config.hasuraUrl,
        wsConnected: !!ctx.wsSubscriber,
      });
      bus?.emit({ type: "connection_status", subsystem: "rpc", status: ctx.publicClient ? "connected" : "disconnected" });
      bus?.emit({ type: "connection_status", subsystem: "hasura", status: ctx.config.hasuraUrl ? "connected" : "disconnected" });
      bus?.emit({ type: "connection_status", subsystem: "ws", status: ctx.wsSubscriber ? "connected" : "disconnected" });
      const hiStatus = ctx.hyperIndexMonitor ? ctx.hyperIndexMonitor.getLastStatus() : undefined;

      // Hot-bias mode comes from the same env var the hyperindex sees.
      // When true, the indexer limits pool discovery to "hot" major tokens (conservative mode).
      // Default (false) = broad long-tail discovery (primary strategy).
      const indexerHotBias = process.env.INDEXER_HOT_BIAS === "true" || process.env.INDEXER_HOT_BIAS === "1";
      const discoveryMode: "broad" | "hot-bias" = indexerHotBias ? "hot-bias" : "broad";

      const payload = buildStatusPayload(
        ctx.metrics,
        gasSnapshot.gasPrice,
        hasuraPoolsCache?.length ?? 0,
        hiStatus
          ? {
              synced: hiStatus.synced,
              remote: hiStatus.remote,
              lag: hiStatus.lag,
              syncRate: hiStatus.syncRate,
              healthy: ctx.hyperIndexMonitor!.isHealthy(),
              discoveryMode,
            }
          : undefined,
      );
      writeStatusFile(ctx.config.paths.dataDir, payload).catch(() => {});

      // Reorg + block tracking: LF (1s) or explicit newHead from WS only.
      // Previously this (plus checkReorg's serial getBlocks) ran every 200ms — major hot-path violation.
      if (ctx.reorgDetector && ctx.publicClient && now - lastReorgCheck > LF_INTERVAL) {
        lastReorgCheck = now;
        const detector = ctx.reorgDetector; // narrow for the block
        try {
          // Only check on slow cadence
          const reorged = await detector.checkReorg();
          if (reorged.size > 0) {
            ctx.logger.warn({ reorgedBlocks: [...reorged].join(",") }, "Reorg detected — forcing state refresh");
            lastRefreshTime = 0;
            detector.clearReorged();
          }

          const latest = ctx.hyperSync
            ? await ctx.hyperSync.getBlockByNumber("latest")
            : ctx.hyperRpc
              ? await ctx.hyperRpc.getBlockByNumber("latest")
              : await ctx.publicClient.getBlock({ blockTag: "latest" });
          if (latest?.number && latest?.hash) {
            await detector.trackBlock(Number(latest.number), latest.hash as `0x${string}`);
          }
        } catch {
          /* best effort */
        }
      }

      // Block-aligned HF timing: skip to next cycle immediately on newHead,
      // fall back to normal 200ms polling after HEAD_TIMEOUT_MS without a head.
      const sinceLastHead = Date.now() - lastHeadTime;
      const isHeadDriven = headTriggered && sinceLastHead < HEAD_TIMEOUT_MS;
      const waitMs = isHeadDriven ? 50 : Math.max(50, HF_INTERVAL - elapsed);
      headTriggered = false;
      bus?.emit({ type: "pipeline_stage", stage: "IDLE" });
      await sleep(waitMs);
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
