/**
 * src/utils/validation_job.js — Periodic registry validation job
 *
 * Runs registry validation on a configurable cron-style interval.
 * Logs validation issues found and emits Prometheus metrics when available.
 *
 * Usage:
 *   import { startValidationJob, stopValidationJob } from "./validation_job.js";
 *   startValidationJob(registry, { intervalMs: 10 * 60 * 1000 });
 *
 * The job runs immediately on start, then repeats on the given interval.
 * It is intentionally lightweight: validation reads the DB synchronously
 * but is fast enough to run in the main thread without blocking the hot path.
 */

import { logger } from "./logger.ts";

// ─── Defaults ──────────────────────────────────────────────────

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

// ─── Job state ─────────────────────────────────────────────────

let _timer: ReturnType<typeof setInterval> | null = null;

type RegistryValidationIssue = {
  pool: {
    pool_address?: unknown;
  };
  issues: readonly string[];
};

type ValidationRegistry = {
  validateAllPools: () => RegistryValidationIssue[];
  getActivePoolCount: () => number;
};

type ValidationJobOptions = {
  intervalMs?: number;
  runImmediately?: boolean;
};

// ─── Core validation runner ────────────────────────────────────

/**
 * Run a single validation pass against the registry.
 *
 * @param {import('../db/registry.ts').RegistryService} registry
 * @returns {Promise<{ issues: number, total: number, invalid: Array }>}
 */
async function runValidation(registry: ValidationRegistry) {
  const start = Date.now();

  let total = 0;
  let invalid: RegistryValidationIssue[] = [];

  try {
    invalid = registry.validateAllPools();
    total = registry.getActivePoolCount();
  } catch (err) {
    logger.error({ err }, "[validation_job] Failed to run validateAllPools");
    return { issues: -1, total: 0, invalid: [] };
  }

  const elapsed = Date.now() - start;
  const issueCount = invalid.reduce((sum, entry) => sum + entry.issues.length, 0);

  if (issueCount === 0) {
    logger.info({ total, elapsed_ms: elapsed }, "[validation_job] Registry validation passed — no issues found");
  } else {
    logger.warn(
      { total, invalid_pools: invalid.length, issues: issueCount, elapsed_ms: elapsed },
      "[validation_job] Registry validation found issues",
    );

    for (const entry of invalid.slice(0, 20)) {
      for (const issue of entry.issues) {
        logger.warn({ pool: entry.pool.pool_address }, `[validation_job] ${issue}`);
      }
    }

    if (invalid.length > 20) {
      logger.warn(`[validation_job] ... and ${invalid.length - 20} more invalid pools (truncated)`);
    }
  }

  // Emit Prometheus metric if metrics module is available
  try {
    const metricsModule = await import("./metrics.ts");
    if (metricsModule?.registryInvalidPools) {
      metricsModule.registryInvalidPools.set(invalid.length);
    }
  } catch {
    // Metrics not available — silently skip
  }

  return { issues: issueCount, total, invalid };
}

// ─── Public API ────────────────────────────────────────────────

/**
 * Start the periodic validation job.
 *
 * The first pass runs immediately (synchronously within the first event loop
 * tick), then repeats every `intervalMs` milliseconds.
 *
 * @param {import('../db/registry.ts').RegistryService} registry
 * @param {Object}  [options]
 * @param {number}  [options.intervalMs=600000]  Interval between passes (ms)
 * @param {boolean} [options.runImmediately=true] Run one pass on startup
 * @returns {{ stop: Function }}  Handle with a `stop()` method
 */
export function startValidationJob(registry: ValidationRegistry, options: ValidationJobOptions = {}) {
  const { intervalMs = DEFAULT_INTERVAL_MS, runImmediately = true } = options;

  if (_timer !== null) {
    logger.warn({ event: "validation_job_duplicate_start" }, "Validation job already running; ignoring duplicate start");
    return { stop: stopValidationJob };
  }

  logger.info({ event: "validation_job_start", interval_ms: intervalMs }, "Starting periodic registry validation job");

  if (runImmediately) {
    // Defer by one tick so callers can finish setup before the first pass
    setImmediate(() => runValidation(registry));
  }

  _timer = setInterval(() => runValidation(registry), intervalMs);

  // Don't prevent process exit if this is the only pending handle
  if (_timer.unref) _timer.unref();

  return { stop: stopValidationJob };
}

/**
 * Stop the periodic validation job.
 */
export function stopValidationJob() {
  if (_timer !== null) {
    clearInterval(_timer);
    _timer = null;
    logger.info({ event: "validation_job_stop" }, "Periodic registry validation job stopped");
  }
}
