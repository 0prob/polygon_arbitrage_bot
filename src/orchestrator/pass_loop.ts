import type { RuntimeContext } from "./boot.ts";
import {
  type FoundCycle,
  findCycles,
  enumerateCycles,
  enumerateCyclesBellmanFord,
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
import { MAJOR_TOKENS } from "../core/constants.ts";

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
  lastDiscoveredBlock: number,
  onNewPools: (pools: PoolMeta[]) => void,
): Promise<{ pools: PoolMeta[] | null; lastDiscoveryTime: number; lastDiscoveredBlock: number }> {
  ctx.logger.debug({}, "runPoolDiscovery called");
  const now = Date.now();
  const DISCOVERY_INTERVAL = 60000;
  if (
    !(
      currentPools === null ||
      currentPools.length === 0 ||
      (now - lastDiscoveryTime > DISCOVERY_INTERVAL && ctx.tierManager.shouldDiscover())
    )
  ) {
    return { pools: currentPools, lastDiscoveryTime, lastDiscoveredBlock };
  }

  bus?.emit({ type: "pipeline_stage", stage: "DISCOVERY" });
  const graphqlUrl = ctx.config.hasuraUrl;
  const secret = ctx.config.hasuraSecret;

  if (!currentPools || currentPools.length === 0) {
    ctx.logger.info({}, "No pools — discovering from Hasura");
  } else {
    ctx.logger.info({ lastDiscoveredBlock }, "Polling Hasura for new pools");
  }

  const newLastDiscoveryTime = now;
  try {
    const discoveryStartTime = Date.now();
    const result = await ctx.rpcCircuit.execute(
      () =>
        deps.discoverPoolsFromHasura(graphqlUrl, secret, ctx.logger, {
          lastDiscoveredBlock,
        }),
      async () => {
        ctx.logger.warn({}, "Hasura circuit open, returning empty pool list");
        return { pools: [], maxBlock: lastDiscoveredBlock };
      },
    );
    const hasuraPools = result.pools;
    const newMaxBlock = result.maxBlock;
    const discoveryElapsed = Date.now() - discoveryStartTime;

    if (hasuraPools.length > 0) {
      // If incremental (lastDiscoveredBlock > 0), merge with currentPools.
      // If full sync, just use hasuraPools.
      const mapped: PoolMeta[] = hasuraPools.map((p) => ({
        address: p.address as `0x${string}`,
        protocol: p.protocol,
        token0: (p.tokens[0] ?? "") as `0x${string}`,
        token1: (p.tokens[1] ?? "") as `0x${string}`,
        tokens: p.tokens as `0x${string}`[],
        fee: p.fee,
      }));

      let finalPools: PoolMeta[];
      if (lastDiscoveredBlock > 0 && currentPools) {
        // Incremental merge
        const seen = new Set(currentPools.map((p) => p.address.toLowerCase()));
        finalPools = [...currentPools];
        let added = 0;
        for (const p of mapped) {
          if (!seen.has(p.address.toLowerCase())) {
            finalPools.push(p);
            seen.add(p.address.toLowerCase());
            added++;
          }
        }
        ctx.logger.info({ added, total: finalPools.length, durationMs: discoveryElapsed }, "Incremental pool discovery updated");
      } else {
        // Full sync or first load
        finalPools = mapped;
        ctx.logger.info({ discovered: mapped.length, durationMs: discoveryElapsed }, "Full pool discovery updated");
      }

      onNewPools(finalPools);

      const protocolBreakdown = finalPools.reduce(
        (acc, p) => {
          const proto = p.protocol.split("_")[0] ?? p.protocol;
          acc[proto] = (acc[proto] ?? 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      );

      const lagBlocks = (ctx.hyperIndexMonitor as any)?.getLastStatus?.().lag || 0;

      bus?.emit({
        type: "discovery_summary",
        poolCount: finalPools.length,
        protocolBreakdown,
        lagBlocks,
      });

      return { pools: finalPools, lastDiscoveryTime: newLastDiscoveryTime, lastDiscoveredBlock: newMaxBlock };
    }

    if (!currentPools) {
      onNewPools([]);
      return { pools: [], lastDiscoveryTime: newLastDiscoveryTime, lastDiscoveredBlock: newMaxBlock };
    }
    return { pools: currentPools, lastDiscoveryTime: newLastDiscoveryTime, lastDiscoveredBlock: newMaxBlock };
  } catch (e) {
    ctx.logger.warn({ err: e }, "Failed to discover pools from Hasura");
    ctx.metrics.totalErrors++;
    ctx.metrics.lastErrorTime = Date.now();
    ctx.metrics.lastErrorMessage = "Failed to discover pools from Hasura";
  }
  return { pools: currentPools, lastDiscoveryTime: newLastDiscoveryTime, lastDiscoveredBlock };
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
    const [gqlCache, fetchedProgress] = await Promise.all([
      ctx.hasuraCircuit.execute(() => deps.buildStateCacheFromGraphQL(graphqlUrl, secret, ctx.logger)),
      ctx.hasuraCircuit.execute(() => deps.fetchIndexerProgressFromHasura(graphqlUrl, secret, ctx.logger))
    ]);
    const progress = fetchedProgress;
    let newEntries = 0;
    let skippedStale = 0;
    for (const [addr, state] of gqlCache.entries()) {
      if (!stateCache.has(addr)) {
        const s = state as Record<string, unknown>;
        const liq = typeof s.liquidity === "bigint" ? (s.liquidity as bigint) : null;
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

  // Refresh state for pools referenced by current cycles (and any missing anchors).
  // This is critical: indexer *PoolState writes are no-ops (perf), so bot's RPC fetcher is the
  // only source of live reserves/slot0/liquidity. Without re-fetch, states freeze after first touch
  // and sims see stale prices => grossProfitMatic<=0 for all cycles => 100% prune.
  // Await so enum + assessment in this LF use fresh data.
  const stateClient = ctx.stateClient ?? ctx.publicClient;
  const updated = new Set<string>();
  if (pools.length > 0 && currentCycles.length > 0) {
    try {
      const fetched = await fetchMissingPoolState(stateClient, stateCache, pools, currentCycles, [], false);
      for (const a of fetched) updated.add(a);
    } catch (err) {
      ctx.logger.debug?.({ err }, "State refresh fetch failed (will retry next LF)");
    }
  }

  // Bootstrap: on first LF pass, pre-fetch V2/V3 state for a sensible number of pools.
  // This lets rate propagation reach thousands of tokens on the very first pass
  // instead of waiting for gradual state accumulation through pre-fetch cycles.
  // BROADER: larger limit + prioritize pools touching major tokens (WMATIC + stables/WETH etc)
  // so computeMaticRates (which seeds those majors) can propagate rates to far more tokens
  // immediately. This increases # of rateSafeCycles, reduces noRate %, and surfaces more
  // (and better) long-tail opportunities instead of only marginal hot V2 pairs.

  // Low infra detection must precede bootstrap/gradual/etc uses of lowInfra.
  const rps = ctx.config.rpc.chainstackRps ?? 250;
  const lowInfra = rps <= 250;

  if (stateCacheEmpty) {
    const BASE_MAX = 12000;
    // AGENT: DO NOT raise the lowInfra bootstrap cap above 5000.
    // Each bootstrap batch is a multicall burst against a 250 RPS node. Raising this value
    // causes the node to throttle or error during the first ~30s of operation, starving the
    // hot-path simulation loop of RPC budget and delaying the first profitable cycle detection.
    // The cap was deliberately halved from 8400 to 5000 to keep bursts manageable.
    // Only change if CHAINSTACK_RPS is raised above 250 in the environment.
    const MAX_BOOTSTRAP_POOLS = lowInfra ? 5000 : BASE_MAX;
    const stateAddrSet = new Set<string>();
    for (const addr of stateCache.keys()) stateAddrSet.add(addr);
    const missingPools = pools.filter((p) => !stateAddrSet.has(p.address.toLowerCase()));

    // Prioritize majors so initial rate graph is well-connected (directly attacks high noRate
    // and low coverage that starves assessment of rateSafe cycles).
    // Using imported MAJOR_TOKENS from constants.ts (synced with hot_tokens.ts)

    const touchesMajor = (p: PoolMeta) => {
      const ts = (p.tokens ?? [p.token0, p.token1]).map((t) => t.toLowerCase());
      return ts.some((t) => MAJOR_TOKENS.has(t));
    };

    const prioritized = [...missingPools].sort((a, b) => (touchesMajor(b) ? 1 : 0) - (touchesMajor(a) ? 1 : 0));
    const toBootstrap = prioritized.slice(0, MAX_BOOTSTRAP_POOLS);

    if (toBootstrap.length > 0) {
      const majorCount = prioritized.filter(touchesMajor).length;
      ctx.logger.info(
        { missingPools: toBootstrap.length, majorConnected: majorCount, lowInfra },
        "Bootstrap: pre-fetching V2/V3 state for rate propagation (non-blocking)",
      );
      // Non-blocking: state accumulates into shared ctx.stateCache as batches complete.
      runBootstrapInBackground(ctx, stateClient, toBootstrap, updated, lowInfra).catch((err) =>
        ctx.logger.warn({ err }, "Background bootstrap failed"),
      );
    }
  }

  // Gradual cache expansion: periodically force-refresh a batch of uncached pools
  // until the cache reaches target size (~75% of total pools). Uses stateClient (dedicated RPC)
  // so it doesn't compete with the hot path.
  _lfStateRefreshCount++;
  const CACHE_TARGET = 30000;
  // AGENT: DO NOT reduce EXPANSION_CADENCE below 20 or raise EXPANSION_BATCH above 1000
  // for the lowInfra path. The LF tick fires every 1 second. At cadence=20 the gradual
  // expansion fires every 20 seconds; at cadence=10 it fires every 10 seconds.
  // Each expansion batch is a blocking multicall sequence on the state client.
  // A 3000-pool batch at cadence=10 generates ~6 multicall RPCs every 10s = 0.6 RPS of
  // continuous background load that directly competes with hot-path cycle-state fetches.
  // The current settings (cadence=20, batch=1000) keep background load under 0.1 RPS.
  const EXPANSION_CADENCE = lowInfra ? 20 : 10;
  // Fire-and-forget: state accumulates into shared ctx.stateCache as batches complete.
  if (!stateCacheEmpty && stateCache.size < CACHE_TARGET && _lfStateRefreshCount % EXPANSION_CADENCE === 0) {
    const BASE_EXP = 6000;
    const EXPANSION_BATCH = lowInfra ? 1000 : BASE_EXP;
    const uncached = pools.filter((p) => !stateCache.has(p.address.toLowerCase()));
    if (uncached.length > 0) {
      const batch = uncached.slice(0, EXPANSION_BATCH);
      const uncachedLen = uncached.length;
      fetchMissingPoolState(stateClient, stateCache, batch, [], [], true)
        .then((expanded) => {
          if (expanded.size > 0) {
            for (const addr of expanded) updated.add(addr);
            ctx.logger.info(
              { expanded: expanded.size, totalCached: stateCache.size, remaining: uncachedLen - expanded.size, lowInfra },
              "Gradual cache expansion batch complete (background)",
            );
          }
        })
        .catch((err) => ctx.logger.warn({ err }, "Background gradual expansion failed"));
    }
  }

  return { lastRefreshTime: now, lastFullRefreshTime: now, ratesNeedFullRefresh: true, updated };
}

/**
 * Fire-and-forget background bootstrap: fetched state accumulates into the shared
 * ctx.stateCache so enumeration and subsequent passes can use it incrementally.
 */
async function runBootstrapInBackground(
  ctx: RuntimeContext,
  stateClient: import("viem").PublicClient,
  toBootstrap: PoolMeta[],
  updated: Set<string>,
  lowInfra: boolean = false,
): Promise<void> {
  const stateCache = ctx.stateCache;
  // AGENT: DO NOT increase BATCH_SIZE_BS or CONCURRENCY_BS for the lowInfra path.
  // These two constants jointly cap the peak RPC fan-out during bootstrap.
  // Math: CONCURRENCY_BS(3) × BATCH_SIZE_BS(2000) pools / 500-multicall-batch = 12 concurrent
  // multicall requests. Each multicall counts as one RPS unit, so peak draw is ~12 RPS — safely
  // within a 250 RPS budget shared with the live trading loop.
  // Raising either value risks hitting the node rate-limit during boot, causing all subsequent
  // state fetches to fail and the bot to run on stale/empty reserves for multiple minutes.
  const BATCH_SIZE_BS = lowInfra ? 2000 : 5000;
  const CONCURRENCY_BS = lowInfra ? 3 : 6;
  const batches: PoolMeta[][] = [];
  for (let i = 0; i < toBootstrap.length; i += BATCH_SIZE_BS) {
    batches.push(toBootstrap.slice(i, i + BATCH_SIZE_BS));
  }
  const localUpdated = new Set<string>();
  for (let i = 0; i < batches.length; i += CONCURRENCY_BS) {
    const chunk = batches.slice(i, i + CONCURRENCY_BS);
    const results = await Promise.all(chunk.map((batch) => fetchMissingPoolState(stateClient, stateCache, batch, [], [], true)));
    for (const res of results) {
      for (const addr of res) {
        localUpdated.add(addr);
        updated.add(addr);
      }
    }
  }
  ctx.logger.info(
    { seedFetched: localUpdated.size, stillMissing: toBootstrap.length - localUpdated.size, lowInfra },
    "Background bootstrap fetch complete",
  );
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
  const baseMaxPaths = ctx.config.routing.enumerationMaxPaths;
  const rpsForEnum = ctx.config.rpc.chainstackRps ?? 250;
  const lowForEnum = rpsForEnum <= 250;
  // AGENT: DO NOT raise the lowInfra maxPaths cap above 8000.
  // Simulation is the dominant hot-path cost: each cycle requires ternary/Brent search
  // (up to 10 iterations × 1 simulateHop call per edge). At 8000 cycles × 3 edges × 10
  // iterations = 240,000 calls in a single 200ms window — already at the compute limit
  // for a single-thread JS event loop on typical hardware.
  // Raising this causes HF cycles to exceed 200ms, losing block-aligned timing and allowing
  // competitors to front-run opportunities that the bot identifies but submits too late.
  // The finder's obscurity-first DFS front-loads the highest-alpha (DODO/Balancer/Curve) cycles,
  // so truncating the tail at 8000 drops only the least-competitive paths.
  const maxPaths = lowForEnum ? Math.min(8000, Math.floor(baseMaxPaths * 0.8)) : baseMaxPaths;
  const finderFn = ctx.config.routing.cycleFinder === "bellman-ford" ? enumerateCyclesBellmanFord : deps.enumerateCycles;
  const cycles = await finderFn(graph, MAX_HOPS, maxPaths, (key) => ctx.executionService.tracker.getWinRate(key));
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
  ctx.logger.info({}, "runPassLoop started");
  const executorAddress = ctx.config.execution.executorAddress;
  const operatorAccount = privateKeyToAccount(ctx.config.execution.privateKey as `0x${string}`);
  const operatorAddress = operatorAccount.address;

  await Promise.all([ctx.executionService.start(), ctx.mempoolService.start()]);

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
          if (event.blockNumber > 0) {
            ctx.pendingStateOverlay?.clear();
          }
        }
      });
    } catch (err) {
      ctx.logger.warn({ err }, "Failed to start WebSocket subscriber");
    }
  }

  bus?.emit({ type: "pass_loop_started", intervalMs: 200 });
  ctx.logger.info({}, "Pass loop started with multi-frequency cycles");

  let isPaused = false;
  bus?.on((ev) => {
    if (ev.type === "pause_toggled") {
      isPaused = ev.isPaused;
    }
  });

  let cachedGraph: RoutingGraph | null = null;
  let cachedCycles: FoundCycle[] = [];
  let hasuraPoolsCache: PoolMeta[] | null = null;
  let lastRefreshTime = 0;
  let lastFullRefreshTime = 0;
  let lastDiscoveryTime = 0;
  let lastDiscoveredBlock = 0;
  let lastMempoolTraceId: string | undefined = undefined;
  let cachedRates: Map<string, bigint> | null = null;
  let cachedMetas: Map<string, { decimals: number }> | null = null;
  // Rate refresh intent flags — set by LF / pre-fetch paths, consumed by single ensureRates block
  let ratesNeedFullRefresh = false;
  let pendingFocusTokens: Set<string> | null = null;

  const HF_INTERVAL = 200;
  const LF_INTERVAL = 1000;
  const TIER_CHECK_INTERVAL = 5000;
  let preFetchCounter = 0;
  let lastTierCheck = 0;

  const recentRouteTimestamps = new Map<string, number>();
  // AGENT: DO NOT reduce ROUTE_COOLDOWN_MS below 12000 for the lowInfra path.
  // On poor infrastructure, transaction confirmation latency can exceed 5–8 seconds.
  // A cooldown shorter than confirmation time causes the bot to resubmit the same route
  // while the original tx is still pending in the mempool, wasting gas on a duplicate and
  // risking two competing self-fills if both land. 12s provides a safe margin above the
  // observed 95th-percentile Polygon confirmation time on congested public nodes.
  const lowInfraForCooldown = (ctx.config.rpc.chainstackRps ?? 250) <= 250;
  const ROUTE_COOLDOWN_MS = lowInfraForCooldown ? 12000 : 5000;

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
        traceId: signal.data.traceId,
      });
      lastDiscoveryTime = 0;
    }
    if (signal.type === "large_swap") {
      lastMempoolTraceId = signal.data.traceId;
      bus?.emit({
        type: "mempool_pending_swap",
        poolPath: signal.data.poolAddress,
        value: signal.data.estimatedSwapSize,
        txHash: signal.data.txHash,
        traceId: signal.data.traceId,
      });
      lastRefreshTime = 0;
    }
  });

  let cycleWindowStart = Date.now();
  let lastReorgCheck = 0;
  let lastStatusWriteTime = 0;

  while (ctx.isRunning) {
    if (isPaused) {
      bus?.emit({ type: "pipeline_stage", stage: "IDLE" });
      await sleep(200);
      continue;
    }
    const now = Date.now();
    const startTime = now;
    const currentPassTraceId = lastMempoolTraceId;
    lastMempoolTraceId = undefined;

    // Timing instrumentation for bottleneck analysis
    let t_point = Date.now();
    const timings: Record<string, number> = {};
    const mark = (name: string) => {
      timings[name] = Date.now() - t_point;
      t_point = Date.now();
    };

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
        const result = await runPoolDiscovery(
          ctx,
          deps,
          bus,
          hasuraPoolsCache,
          lastDiscoveryTime,
          lastDiscoveredBlock,
          (newPools) => {
            hasuraPoolsCache = newPools;
            cachedGraph = deps.buildGraph(newPools, stateCache);
            ctx.graphUpdater?.resetRebuildCounter();
            if (newPools && newPools.length > 0) {
              ctx.mempoolService.setKnownPools(newPools.map((p) => p.address));
              ctx.logger.info({ count: newPools.length }, "Pool discovery updated known pools");
            }
          },
          );
          hasuraPoolsCache = result.pools;
        lastDiscoveryTime = result.lastDiscoveryTime;
        lastDiscoveredBlock = result.lastDiscoveredBlock;
      }
      mark("poolDiscovery");

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
      mark("lfRefresh");

      // Stage 3: Filter pools, rebuild graph, enumerate cycles
      let didEnumerateThisPass = false;
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
        didEnumerateThisPass = enumResult.didEnumerate;
      }
      mark("enumeration");

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
      mark("fetchMetas");

      const currentCycles = cachedCycles;

      // Post-enum (only on LF enum passes): refresh states for *this pass's* cycles so rates + sim see current reserves/liquidity/slot0.
      // (HF passes reuse the just-refreshed cache.) Critical for >0 grossProfit detections on non-stale data.
      if (didEnumerateThisPass && currentCycles.length > 0 && (hasuraPoolsCache?.length ?? 0) > 0) {
        try {
          const sc = ctx.stateClient ?? ctx.publicClient;
          const cachePools = hasuraPoolsCache ?? [];
          const freshly = await fetchMissingPoolState(sc, stateCache, cachePools, currentCycles, [], false);
          for (const a of freshly) updatedPools.add(a);
        } catch (e) {
          ctx.logger.debug?.({ err: e }, "post-enum cycle state refresh warn");
        }
      }

      if (currentCycles.length === 0) {
        bus?.emit({ type: "pipeline_stage", stage: "IDLE" });
        await sleep(HF_INTERVAL);
        continue;
      }

      // Compute once to avoid redundant O(N) loops and .toLowerCase() calls which stress GC
      const cycleTokens = new Set<string>();
      for (const c of currentCycles) {
        cycleTokens.add(c.startToken.toLowerCase());
        for (const e of c.edges) {
          cycleTokens.add(e.tokenIn.toLowerCase());
          cycleTokens.add(e.tokenOut.toLowerCase());
        }
      }

      // High-frequency pre-fetch: Only for pools in current cycles
      // Skip if we just did a full refresh in the same pass.
      // Non-blocking: state accumulates into ctx.stateCache, subsequent cycles benefit.
      preFetchCounter++;
      // AGENT: DO NOT reduce preFetchModulo below 8 for the lowInfra path.
      // The HF loop ticks at ~200ms. A modulo of 5 fires a pre-fetch every 1 second;
      // a modulo of 8 fires every 1.6 seconds. The pre-fetch is NOT fire-and-forget for
      // the cycle-pool fetch — it races against the LF state refresh that runs on the same
      // 1s cadence. At modulo=5 both fire in the same second on every LF tick, doubling
      // RPC pressure at exactly the moment the simulation most needs fresh state.
      const lowInfraForPrefetch = (ctx.config.rpc.chainstackRps ?? 250) <= 250;
      const preFetchModulo = lowInfraForPrefetch ? 8 : 5;
      if (lastFullRefreshTime !== now && preFetchCounter % preFetchModulo === 0) {
        bus?.emit({ type: "pipeline_stage", stage: "PRE_FETCH" });

        // Fire-and-forget cycle pool state fetch.
        fetchMissingPoolState(ctx.stateClient ?? ctx.publicClient, stateCache, hasuraPoolsCache ?? [], currentCycles, [], false).catch(
          () => {},
        );

        // Fire-and-forget broad token pool pre-fetch.
        {
          const broadTokenPools: PoolMeta[] = [];
          for (const p of hasuraPoolsCache ?? []) {
            const pts = (p.tokens ?? [p.token0, p.token1]).map((t: string) => t.toLowerCase());
            if (pts.some((t: string) => cycleTokens.has(t)) && !stateCache.has(p.address.toLowerCase())) {
              broadTokenPools.push(p);
            }
          }
          if (broadTokenPools.length > 0) {
            const rpsBroad = ctx.config.rpc.chainstackRps ?? 250;
            const lowBroad = rpsBroad <= 250;
            // AGENT: DO NOT raise the lowInfra broadCap above 400.
            // The broad pre-fetch fires every ~1.6s (preFetchModulo=8 × 200ms HF interval).
            // 400 pools / 500-multicall-batch = 1 multicall RPC per trigger — negligible.
            // 2000 pools = 4 multicalls per trigger = 2.5 RPS of continuous background load,
            // which on a 250 RPS node is 1% of total budget consumed by a speculative fetch
            // that only benefits cycles not yet in the state cache. The marginal value does
            // not justify the RPS cost on constrained infrastructure.
            const broadCap = lowBroad ? 400 : 5000;
            const cap = broadTokenPools.slice(0, broadCap);
            fetchMissingPoolState(ctx.stateClient ?? ctx.publicClient, stateCache, cap, [], [], true)
              .catch(() => {});
          }
        }

        // Signal incremental rate update with focus tokens derived from current cycles.
        {
          pendingFocusTokens = cycleTokens.size > 0 ? cycleTokens : null;
        }
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
        if (cycleTokens.size > 0) {
          const boosted = computeMaticRates(hasuraPoolsCache ?? [], stateCache, ctx.logger, {
            minLiquidityV3: ctx.config.execution.minLiquidityV3Rate,
            seedRates: tokenToMaticRates,
            focusTokens: cycleTokens,
          });
          cachedRates = boosted;
          tokenToMaticRates = boosted;
        }
      }

      // Filter out quarantined routes before simulation to avoid repetitive noise.
      // Prefer cycle.id (pre-computed by enumerateCycles when win-rate scoring is active)
      // to avoid redundant O(N log N) routeKeyFromEdges work.
      const filteredCycles = currentCycles.filter((cycle) => {
        const routeKey = cycle.id ?? deps.routeKeyFromEdges(cycle.edges);
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
      const baseConc = ctx.config.routing.concurrency ?? 50;
      let effectiveConcurrency = isDegraded ? Math.max(10, Math.floor(baseConc * 0.4)) : baseConc;
      const rpsConc = ctx.config.rpc.chainstackRps ?? 250;
      if (rpsConc <= 250) {
        // AGENT: DO NOT raise the floor above 4 or remove the 0.5× reduction for lowInfra.
        // Simulation concurrency controls how many Promise.all batches run simultaneously.
        // Higher concurrency does NOT reduce wall-time when the bottleneck is the single-threaded
        // JS event loop — it only increases GC pressure from additional object allocations per
        // ternary-search iteration. Keeping it at max(4, base×0.5) maintains throughput while
        // reducing per-cycle jitter, which is essential for block-aligned HF timing.
        effectiveConcurrency = Math.max(4, Math.floor(effectiveConcurrency * 0.5));
      }
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
        ctx.logger.debug(
          { totalFiltered: filteredCycles.length, rates: tokenToMaticRates.size },
          "No rate-covered cycles this pass (coverage still growing)",
        );
      }

      const simStartTime = Date.now();
      const result = await deps.evaluatePipeline(rateSafeCycles, stateCache, options, ctx.pendingStateOverlay);
      const simElapsed = Date.now() - simStartTime;
      mark("simulation");

      ctx.metrics.opportunitiesFound += result.profitableCount;

      // Emit full simulation breakdown for TUI visibility and debugging
      bus?.emit({
        type: "simulation_stats",
        attempted: result.attempted,
        simulated: result.simulated,
        profitable: result.profitableCount,
        noRate: result.noRate,
        prunedMissingState: result.prunedMissingState,
        prunedNoGrossProfit: result.prunedNoGrossProfit,
        prunedInvalidBounds: result.prunedInvalidBounds,
        prunedFinalCheckFailed: result.prunedFinalCheckFailed,
        maxGrossMilliMatic: result.maxGrossProfitMatic !== undefined ? Number(result.maxGrossProfitMatic / 10n ** 15n) : 0,
        durationMs: simElapsed,
        ratesCovered: tokenToMaticRates.size,
        cacheSize: stateCache.size,
        rateSafeCycles: rateSafeCycles.length,
        totalCycles: filteredCycles.length,
      });

      if (result.attempted > 0) {
        const tier = ctx.tierManager.getCurrent();
        if (result.profitable.length > 0 && !ctx.tierManager.shouldExecute()) {
          ctx.logger.debug({ tier, count: result.profitable.length }, "Execution suppressed by degradation tier");
        } else if (result.profitable.length > 0) {
          const candidates: { candidate: CandidateExecution; profitable: (typeof result.profitable)[number]; routeKey: string }[] = [];

          const candidatePromises = result.profitable.map(async (profitable) => {
            if (!ctx.isRunning) return null;

            const routeKey = profitable.cycle.id ?? deps.routeKeyFromEdges(profitable.cycle.edges);

            const lastSubmit = recentRouteTimestamps.get(routeKey);
            if (lastSubmit && now - lastSubmit < ROUTE_COOLDOWN_MS) {
              ctx.logger.debug({ routeKey, lastSubmit, now }, "Route recently submitted, skipping cooldown");
              return null;
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

            if (!profitable.result.profitable) return null;

            // Capture full simulation trace for debugging
            deps.instrumenter.captureTrace(routeKey, profitable.result, stateCache);

            bus?.emit({
              type: "opportunity_found",
              routeKey,
              profitWei: profitable.assessment.netProfitAfterGasMaticWei,
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
                  slippageBps: Number(options.slippageBps ?? 50n) + Math.floor(obscurityRelax) * 2, // base from config + obscurity relaxation up to 50bp; removed prior +500 blanket that caused cascading K errors
                  flashLoanSource: options.flashLoanSource === FlashLoanSource.AAVE_V3 ? "AAVE_V3" : "BALANCER",
                  stateCache,
                },
                currentPassTraceId,
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
                    const { appendFile } = await import("node:fs/promises");
                    const dump =
                      JSON.stringify({
                        ts: Date.now(),
                        routeKey,
                        calldata: candidate.calldata,
                        target: candidate.targetAddress,
                        revertData: dryRun.revertData,
                      }) + "\n";
                    await appendFile("data/failing-calldata.ndjson", dump);
                  } catch {}
                  ctx.executionService.getQuarantineManager().add(routeKey, dryRun.revertReason || dryRun.error);
                  return null;
                }
              }

              return { candidate, profitable, routeKey };
            } catch (err) {
              ctx.logger.error({ err, routeKey }, "Failed to build tx for cycle");
              ctx.metrics.totalErrors++;
              ctx.metrics.lastErrorTime = Date.now();
              ctx.metrics.lastErrorMessage = "Failed to build tx for cycle";
              return null;
            }
          });

          const resolvedCandidates = await Promise.all(candidatePromises);
          for (const res of resolvedCandidates) {
            if (res) candidates.push(res);
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
                  expectedProfit: c.profitable.assessment.netProfitAfterGasMaticWei,
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
                  const cand = candidates.find((c) => c.routeKey === routeKey);
                  let profitWei = 0n;
                  if (cand) {
                    const startRate = tokenToMaticRates.get(cand.profitable.cycle.startToken.toLowerCase()) ?? 0n;
                    const profitInTokens = tracked ? tracked.profit : cand.profitable.assessment.netProfitAfterGas;
                    if (startRate > 0n) {
                      profitWei = (profitInTokens * startRate) / 1000000000000000000n;
                    } else {
                      profitWei = cand.profitable.assessment.netProfitAfterGasMaticWei;
                    }
                  }

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
      mark("execution");

      const elapsed = Date.now() - startTime;
      ctx.metrics.lastCycleDurationMs = elapsed;

      // Minimal HF budget instrumentation (P2 item from debug pass).
      // After previous purges (reorg/getBlock moved out), the loop should comfortably stay < 160 ms.
      // If we ever regress and start doing heavy work in the 200 ms path, this will scream.
      const HF_BUDGET_MS = 160;
      if (elapsed > HF_BUDGET_MS) {
        ctx.logger.debug(
          { elapsed, budget: HF_BUDGET_MS, cycles: ctx.metrics.cycles, timings },
          "HF cycle exceeded budget — possible hot-path regression (reorg, heavy RPC, or expensive simulation)",
        );
      }
      if (!ctx.metrics.maxHotPathDurationMs || elapsed > ctx.metrics.maxHotPathDurationMs) {
        ctx.metrics.maxHotPathDurationMs = elapsed;
      }
      const trackerSummary = ctx.executionService.tracker.summary;
      ctx.metrics.executionReverts = trackerSummary.totalReverts;
      ctx.metrics.trackedRoutes = trackerSummary.trackedRoutes;
      // Calculate dynamic MATIC price in USD from tokenToMaticRates (derived from USDC / Bridged USDC / USDT / DAI)
      let maticPriceUsd = 0.7;
      if (tokenToMaticRates) {
        const usdcAddress = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359".toLowerCase();
        const usdceAddress = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174".toLowerCase();
        const usdtAddress = "0xc2132d05d31c914a87c6611c10748aeb04b58e8f".toLowerCase();
        const daiAddress = "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063".toLowerCase();

        const usdcRate = tokenToMaticRates.get(usdcAddress) || tokenToMaticRates.get(usdceAddress) || tokenToMaticRates.get(usdtAddress);
        if (usdcRate && usdcRate > 0n) {
          maticPriceUsd = 1e30 / Number(usdcRate);
        } else {
          const daiRate = tokenToMaticRates.get(daiAddress);
          if (daiRate && daiRate > 0n) {
            maticPriceUsd = 1e18 / Number(daiRate);
          }
        }
      }

      const isRpcConnected = ctx.rpcCircuit.isHealthy();
      const isHasuraConnected = ctx.hasuraCircuit.isHealthy();
      const isWsConnected = !!ctx.wsSubscriber && ctx.wsSubscriber.isConnected();

      // Enrich heartbeat with profitability & performance metrics for TUI
      const trackerSummary2 = ctx.executionService.tracker.summary;
      const successRateVal =
        trackerSummary2.totalAttempts > 0 ? Math.round((trackerSummary2.totalSuccesses / trackerSummary2.totalAttempts) * 100) : 0;

      bus?.emit({
        type: "heartbeat",
        elapsedMs: elapsed,
        cycles: ctx.metrics.cycles,
        totalErrors: ctx.metrics.totalErrors,
        indexerLag: currentIndexerLag,
        gasPrice: gasSnapshot?.gasPrice,
        rpcConnected: isRpcConnected,
        hasuraConnected: isHasuraConnected,
        wsConnected: isWsConnected,
        maticPriceUsd,
        cyclesPerMin: ctx.metrics.currentCyclesPerMinute,
        peakCpm: ctx.metrics.peakCyclesPerMinute,
        successRate: successRateVal,
        maxHotPathMs: ctx.metrics.maxHotPathDurationMs,
        trackedRoutes: trackerSummary2.trackedRoutes,
      });
      // Only emit connection_status on actual transitions to avoid per-cycle bus noise
      bus?.emit({ type: "connection_status", subsystem: "rpc", status: isRpcConnected ? "connected" : "disconnected" });
      bus?.emit({ type: "connection_status", subsystem: "hasura", status: isHasuraConnected ? "connected" : "disconnected" });
      bus?.emit({ type: "connection_status", subsystem: "ws", status: isWsConnected ? "connected" : "disconnected" });
      const hiStatus = ctx.hyperIndexMonitor ? ctx.hyperIndexMonitor.getLastStatus() : undefined;

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
            }
          : undefined,
      );
      if (now - lastStatusWriteTime > 1000) {
        lastStatusWriteTime = now;
        writeStatusFile(ctx.config.paths.dataDir, payload).catch(() => {});
      }

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
