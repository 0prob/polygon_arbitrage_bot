type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";
type LoggerFn = (msg: string, level?: LogLevel, meta?: unknown) => void;

import {
  normalizeChangedPools,
  normalizeEventPayload,
  normalizeReorgBlock,
  type PoolsChangedEvent,
  type ReorgDetectedEvent,
  type WatcherHaltEvent,
} from "../app/runner.ts";
import { errorMessage } from "../utils/errors.ts";

type StoppableWatcher = {
  stop: () => Promise<void>;
};

type ShutdownRegistry = {
  close: () => void;
};

type StoppableOracle = {
  stop: () => void;
};

type ShutdownReason = "signal" | "fatal" | "complete";
type WatcherCallback = (payload: unknown) => void;
type WatcherHaltCallback = (payload: Record<string, unknown>) => void;
const DEFAULT_SHUTDOWN_CLEANUP_TIMEOUT_MS = 15_000;
type WatcherCallbackTarget = {
  onBatch: WatcherCallback | null;
  onReorg: WatcherCallback | null;
  onHalt: WatcherHaltCallback | null;
};

export function createArbScheduler(deps: {
  isRunning: () => boolean;
  recordArbActivity: (changedPools: number) => void;
  getAdaptiveDebounceMs: () => number;
  runPass: () => Promise<void>;
  onRunError?: (error: unknown) => void;
}) {
  let arbQueued = false;
  let lastArbMs = 0;
  let arbRunning = false;
  let arbDirty = false;
  let arbTimer: ReturnType<typeof setTimeout> | null = null;
  const idleResolvers = new Set<() => void>();
  const MAX_IDLE_WAITERS = 64;

  function flushIdleWaiters() {
    if (arbQueued || arbRunning || arbDirty || arbTimer) return;
    if (idleResolvers.size === 0) return;
    const resolvers = [...idleResolvers];
    idleResolvers.clear();
    for (const resolve of resolvers) resolve();
  }

  function normalizeChangedPoolCount(value: unknown) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return 0;
    return Math.floor(numeric);
  }

  function scheduleArb(changedPools = 0) {
    if (!deps.isRunning()) return;
    const changedPoolCount = normalizeChangedPoolCount(changedPools);
    deps.recordArbActivity(changedPoolCount);
    if (arbQueued || arbRunning) {
      arbDirty = true;
      return;
    }

    const debounceMs = deps.getAdaptiveDebounceMs();
    const delay = Math.max(0, debounceMs - (Date.now() - lastArbMs));
    arbQueued = true;

    arbTimer = setTimeout(async () => {
      arbTimer = null;
      arbQueued = false;
      lastArbMs = Date.now();

      if (!deps.isRunning()) {
        arbDirty = false;
        flushIdleWaiters();
        return;
      }

      if (arbRunning) {
        arbDirty = true;
        return;
      }

      arbRunning = true;
      try {
        await deps.runPass();
      } catch (error) {
        deps.onRunError?.(error);
      } finally {
        arbRunning = false;
        if (arbDirty && deps.isRunning()) {
          arbDirty = false;
          scheduleArb();
          return;
        }
        flushIdleWaiters();
      }
    }, delay);
  }

  function cancelScheduledArb() {
    if (arbTimer) {
      clearTimeout(arbTimer);
      arbTimer = null;
    }
    arbQueued = false;
    arbDirty = false;
    flushIdleWaiters();
  }

  function waitForIdle() {
    if (!arbQueued && !arbRunning && !arbDirty && !arbTimer) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      if (idleResolvers.size < MAX_IDLE_WAITERS) {
        idleResolvers.add(resolve);
      } else {
        resolve();
      }
    });
  }

  return { scheduleArb, cancelScheduledArb, waitForIdle };
}

export function createShutdownHandler(deps: {
  log: LoggerFn;
  setRunning: (running: boolean) => void;
  stopTui: () => void;
  getWatcher: () => StoppableWatcher | null;
  gasOracle: StoppableOracle | null;
  getRegistry: () => ShutdownRegistry | null;
  workerPool: { terminate: () => Promise<void> };
  stopMetricsServer: () => void;
  stopHeartbeat?: () => void;
  cancelScheduledArb?: () => void;
  waitForArbIdle?: () => Promise<void>;
  waitForBackgroundTasks?: () => Promise<void>;
  shutdownCleanupTimeoutMs?: number;
  exit: (code: number) => never;
}) {
  let shutdownPromise: Promise<void> | null = null;

  return async function shutdown(exitCodeOrSignal: number | string = 0, reason: ShutdownReason = "signal") {
    if (shutdownPromise) return shutdownPromise;
    const exitCode = typeof exitCodeOrSignal === "number" ? exitCodeOrSignal : 0;
    const signal = typeof exitCodeOrSignal === "string" ? exitCodeOrSignal : undefined;
    const cleanupTimeoutMs = Math.max(1, Number(deps.shutdownCleanupTimeoutMs ?? DEFAULT_SHUTDOWN_CLEANUP_TIMEOUT_MS));
    async function cleanupStep(step: string, cleanup: () => Promise<void> | void) {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let timedOut = false;
      const cleanupPromise = Promise.resolve().then(cleanup);
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error(`cleanup timed out after ${cleanupTimeoutMs}ms`));
        }, cleanupTimeoutMs);
      });
      try {
        await Promise.race([cleanupPromise, timeoutPromise]);
      } catch (err) {
        deps.log(`Shutdown cleanup failed during ${step}: ${errorMessage(err)}`, "warn", {
          event: timedOut ? "shutdown_cleanup_timeout" : "shutdown_cleanup_error",
          step,
          err,
          ...(timedOut ? { timeoutMs: cleanupTimeoutMs } : {}),
        });
      } finally {
        if (timer) clearTimeout(timer);
        if (timedOut) cleanupPromise.catch(() => {});
      }
    }

    shutdownPromise = (async () => {
      deps.log(reason === "fatal" ? "Fatal error received; shutting down..." : "Shutdown signal received...", "info", {
        event: "shutdown_start",
        reason,
        exitCode,
        ...(signal ? { signal } : {}),
      });
      await cleanupStep("runtime", () => deps.setRunning(false));
      await cleanupStep("heartbeat", () => deps.stopHeartbeat?.());
      await cleanupStep("arb_scheduler", () => deps.cancelScheduledArb?.());
      await cleanupStep("watcher", async () => {
        const watcher = deps.getWatcher();
        if (watcher) await watcher.stop();
      });
      await cleanupStep("arb_idle", () => deps.waitForArbIdle?.());
      await cleanupStep("background_tasks", () => deps.waitForBackgroundTasks?.());
      await cleanupStep("tui", () => deps.stopTui());
      await cleanupStep("gas_oracle", () => deps.gasOracle?.stop());
      await cleanupStep("worker_pool", () => deps.workerPool.terminate());
      await cleanupStep("registry", () => deps.getRegistry()?.close());
      await cleanupStep("metrics", () => deps.stopMetricsServer());
      deps.exit(exitCode);
    })();
    return shutdownPromise;
  };
}

export function configureWatcherCallbacks(deps: {
  watcher: WatcherCallbackTarget;
  log: LoggerFn;
  onPoolsChanged: (event: PoolsChangedEvent) => Promise<void> | void;
  onReorgDetected: (event: ReorgDetectedEvent) => Promise<void> | void;
  onHaltDetected?: (event: WatcherHaltEvent) => Promise<void> | void;
  scheduleArb: (changedPools?: number) => void;
}) {
  deps.watcher.onBatch = (changedAddrs: unknown) => {
    const changedPools = normalizeChangedPools(changedAddrs);
    Promise.resolve(
      deps.onPoolsChanged({
        type: "pools_changed",
        changedPools,
      }),
    )
      .catch((err: unknown) => {
        deps.log(`Watcher batch handling failed: ${errorMessage(err)}`, "warn", {
          event: "watcher_batch_error",
          err,
        });
      })
      .finally(() => {
        deps.scheduleArb(changedPools.size);
      });
  };

  deps.watcher.onReorg = (payload: { reorgBlock?: unknown; changedAddrs?: unknown } | unknown) => {
    const eventPayload = normalizeEventPayload(payload);
    const reorgBlock = normalizeReorgBlock(eventPayload.reorgBlock);
    const changedPools = normalizeChangedPools(eventPayload.changedAddrs);
    if (reorgBlock == null) {
      deps.log("Watcher reorg event ignored because reorgBlock is invalid", "warn", {
        event: "watcher_reorg_invalid",
        reorgBlock: eventPayload.reorgBlock,
        changedPools: changedPools.size,
      });
      deps.scheduleArb(changedPools.size);
      return;
    }

    Promise.resolve(
      deps.onReorgDetected({
        type: "reorg_detected",
        reorgBlock,
        changedPools,
      }),
    )
      .catch((err: unknown) => {
        deps.log(`Watcher reorg handling failed: ${errorMessage(err)}`, "warn", {
          event: "watcher_reorg_error",
          err,
        });
      })
      .finally(() => {
        deps.scheduleArb(changedPools.size);
      });
  };

  deps.watcher.onHalt = (payload: unknown) => {
    Promise.resolve(
      deps.onHaltDetected?.({
        type: "watcher_halt",
        payload: normalizeEventPayload(payload),
      }),
    ).catch((err: unknown) => {
      deps.log(`Watcher halt handling failed: ${errorMessage(err)}`, "warn", {
        event: "watcher_halt_error",
        err,
      });
    });
  };
}
