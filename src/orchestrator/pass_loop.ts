import type { RuntimeContext } from "./boot.ts";
import type { PassLoopDeps } from "./loop.ts";
import type { EventBus } from "../tui/events.ts";
import { ArbInstrumenter } from "../pipeline/index.ts";
import {
  enumerateCycles,
  evaluatePipeline,
  buildGraph,
  routeKeyFromEdges,
} from "../pipeline/index.ts";
import { buildExecutionCandidate } from "../services/execution/candidate.ts";
import { runLfTick } from "./pass_lf.ts";
import { runHfTick } from "./pass_hf.ts";
import type { PassLoopState } from "./pass_state.ts";
import { publishHfSnapshot } from "./hf_snapshot.ts";
import { refreshCyclePoolsOnHead } from "./head_refresh.ts";
import { resolveInfraProfile } from "../config/infra_profile.ts";
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

export const DEFAULT_DEPS: PassLoopDeps = {
  buildGraph,
  enumerateCycles,
  evaluatePipeline,
  routeKeyFromEdges,
  buildExecutionCandidate,
  instrumenter,
};

const HF_INTERVAL = 200;
const LF_INTERVAL = 1000;
const TIER_CHECK_INTERVAL = 5000;
const NONCE_RECOVERY_INTERVAL = 5000;
const HEAD_TIMEOUT_MS = 3000;

export async function runPassLoop(ctx: RuntimeContext, deps: PassLoopDeps = DEFAULT_DEPS, bus?: EventBus): Promise<void> {
  ctx.logger.info({}, "runPassLoop started");

  await Promise.all([ctx.executionService.start(), ctx.mempoolService.start()]);

  // Start WebSocket subscriber if configured
  if (ctx.wsSubscriber) {
    try {
      await ctx.wsSubscriber.start();
      ctx.logger.info({}, "WebSocket subscriber started for real-time events");

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
          state.headTriggered = true;
          state.lastHeadTime = Date.now();
          if (event.blockNumber > 0) {
            ctx.pendingStateOverlay?.clear();
            ctx.pendingOverrideStore?.clear();
          }
          if (event.blockHash && ctx.reorgDetector) {
            ctx.reorgDetector.trackBlock(event.blockNumber, event.blockHash as `0x${string}`).catch((err) => {
              ctx.logger.debug?.({ err }, "trackBlock on newHead failed");
            });
          }
          if (ctx.config.sync.headDrivenRefresh !== false && state.cachedCycles.length > 0) {
            refreshCyclePoolsOnHead(ctx, ctx.stateCache, state.cachedCycles, ctx.config.sync.headRefreshMaxPools).catch(
              (err) => ctx.logger.debug?.({ err }, "Head-driven pool refresh failed"),
            );
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

  const state: PassLoopState = {
    cachedCycles: [],
    hasuraPoolsCache: null,
    cachedMetas: null,
    cachedRates: null,
    tokenToMaticRates: new Map(),
    ratesNeedFullRefresh: false,
    pendingFocusTokens: null,
    lastRefreshTime: 0,
    lastReorgCheck: 0,
    lastStatusWriteTime: 0,
    lastMempoolTraceId: undefined,
    lfEnumerationInFlight: false,
    lastEnumerationTime: 0,
    lastPoolsFingerprint: "",
    cycleWindowStart: Date.now(),
    recentRouteTimestamps: new Map(),
    headTriggered: false,
    lastHeadTime: 0,
    lastTierCheck: 0,
    lfTickInFlight: false,
    maticPriceUsd: 0.7,
    cyclesGeneration: 0,
    hfSnapshot: null,
    hfSimOffset: 0,
    lastEnumStateCacheSize: 0,
  };

  publishHfSnapshot(state);

  const infra = resolveInfraProfile(ctx.config);
  const ROUTE_COOLDOWN_MS = infra.routeCooldownMs;
  let lastNonceRecoveryCheck = 0;

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
    }
    if (signal.type === "large_swap") {
      state.lastMempoolTraceId = signal.data.traceId;
      state.lastLargeSwapSignal = signal.data;
      bus?.emit({
        type: "mempool_pending_swap",
        poolPath: signal.data.poolAddress,
        value: signal.data.estimatedSwapSize,
        txHash: signal.data.txHash,
        traceId: signal.data.traceId,
      });
      state.lastRefreshTime = 0;
      state.lastEnumerationTime = 0;
    }
  });

  while (ctx.isRunning) {
    if (isPaused) {
      bus?.emit({ type: "pipeline_stage", stage: "IDLE" });
      await sleep(200);
      continue;
    }
    const now = Date.now();
    const startTime = now;

    // Timing instrumentation for bottleneck analysis (debug only)
    let t_point = Date.now();
    const timings: Record<string, number> | undefined = ctx.config.observability.logLevel === "debug" ? {} : undefined;
    const mark = (name: string) => {
      if (!timings) return;
      timings[name] = Date.now() - t_point;
      t_point = Date.now();
    };

    const cycleWindow = 60000;
    const elapsedCycleWindow = now - state.cycleWindowStart;
    ctx.metrics.currentCyclesPerMinute = elapsedCycleWindow > 0 ? Math.round((ctx.metrics.cycles * 60000) / elapsedCycleWindow) : 0;
    if (ctx.metrics.currentCyclesPerMinute > ctx.metrics.peakCyclesPerMinute) {
      ctx.metrics.peakCyclesPerMinute = ctx.metrics.currentCyclesPerMinute;
    }
    if (elapsedCycleWindow > cycleWindow) {
      state.cycleWindowStart = now;
    }

    try {
      ctx.metrics.cycles++;

      if (now - state.lastTierCheck > TIER_CHECK_INTERVAL) {
        const tier = ctx.tierManager.assess();
        state.lastTierCheck = now;
        ctx.logger.debug({ tier }, ctx.tierManager.label());
        const staleKeys: string[] = [];
        for (const [key, ts] of state.recentRouteTimestamps) {
          if (now - ts > ROUTE_COOLDOWN_MS * 2) staleKeys.push(key);
        }
        for (const key of staleKeys) state.recentRouteTimestamps.delete(key);
      }

      if (now - lastNonceRecoveryCheck >= NONCE_RECOVERY_INTERVAL) {
        lastNonceRecoveryCheck = now;
        ctx.executionService.tickNonceRecovery().catch((err) => {
          ctx.logger.debug?.({ err }, "Nonce recovery tick failed");
        });
      }

      const stateCache = ctx.stateCache;
      // Time-based LF cadence only; do not re-trigger every HF tick while cycles are empty.
      const isLfTick = now - state.lastRefreshTime >= LF_INTERVAL;

      if (isLfTick && !state.lfTickInFlight) {
        state.lfTickInFlight = true;
        state.lastRefreshTime = now;
        Promise.resolve()
          .then(() => runLfTick(ctx, state, stateCache, deps, bus))
          .catch((err) => { ctx.logger.error({ err }, "Background LF tick failed"); })
          .finally(() => { state.lfTickInFlight = false; });
      }

      mark("hf");
      await runHfTick(ctx, state, stateCache, deps, bus);

      mark("execution");

      const elapsed = Date.now() - startTime;

      // Block-aligned HF timing
      const sinceLastHead = Date.now() - state.lastHeadTime;
      const isHeadDriven = state.headTriggered && sinceLastHead < HEAD_TIMEOUT_MS;
      const waitMs = isHeadDriven ? 50 : Math.max(50, HF_INTERVAL - elapsed);
      state.headTriggered = false;
      bus?.emit({ type: "pipeline_stage", stage: "IDLE" });
      await sleep(waitMs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.logger.error({ err }, "Pass loop error");
      ctx.metrics.totalErrors++;
      ctx.metrics.lastErrorTime = Date.now();
      ctx.metrics.lastErrorMessage = message.slice(0, 200);
      await sleep(HF_INTERVAL);
    }
  }

  ctx.logger.info({}, "Pass loop exited");
}
