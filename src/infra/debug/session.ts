/** Cursor/VS Code debug helpers — active when BOT_DEBUG=1 or --debug is passed. */

export const DebugSites = {
  /** Application boot complete — all services wired. */
  BOOT: "boot",
  /** Main pass loop entered. */
  PASS_LOOP_START: "pass-loop-start",
  /** Unhandled pass-loop iteration error. */
  PASS_LOOP_ERROR: "pass-loop-error",
  /** HF tick (sampled — every 200 ticks). */
  HF_TICK: "hf-tick",
  /** LF cycle enumeration produced routes. */
  LF_ENUM: "lf-enum",
  /** Profitable cycles found after simulation. */
  PROFITABLE_FOUND: "profitable-found",
  /** Dry-run against pending state failed. */
  DRY_RUN_FAIL: "dry-run-fail",
  /** About to submit execution batch. */
  EXECUTE_BATCH: "execute-batch",
  /** MEV backrun bundle submission. */
  BACKRUN_SUBMIT: "backrun-submit",
  /** Transaction submitted to relay. */
  TX_SUBMIT: "tx-submit",
  /** Transaction receipt finalized. */
  TX_RESULT: "tx-result",
  /** Pipeline cycle evaluation error (sampled). */
  PIPELINE_CYCLE_ERROR: "pipeline-cycle-error",
  /** Large mempool swap signal emitted. */
  MEMPOOL_LARGE_SWAP: "mempool-large-swap",
  /** Chain reorg detected — state invalidated. */
  REORG_DETECTED: "reorg-detected",
  /** New pools discovered from indexer. */
  STATE_DISCOVERY: "state-discovery",
  /** Degradation tier changed. */
  TIER_CHANGED: "tier-changed",
  /** HF cycle exceeded budget — hot-path regression. */
  HF_BUDGET_EXCEEDED: "hf-budget-exceeded",
  /** Unhandled fatal error at process exit. */
  FATAL: "fatal",
} as const;

export type DebugSite = (typeof DebugSites)[keyof typeof DebugSites];

const DEBUG_INGEST =
  "http://127.0.0.1:7263/ingest/ac6c9208-c536-42e7-b496-db8499c17483";
const DEBUG_SESSION = "5ca91f";

export function isDebugSession(): boolean {
  return process.env.BOT_DEBUG === "1" || process.argv.includes("--debug");
}

function siteEnabled(site: DebugSite): boolean {
  const filter = process.env.BOT_DEBUG_SITES;
  if (!filter) return true;
  return filter.split(",").map((s) => s.trim()).includes(site);
}

/** Structured NDJSON log for the Cursor debug ingest pipeline. */
export function debugLog(
  location: string,
  message: string,
  data: Record<string, unknown> = {},
  hypothesisId = "bot",
): void {
  if (!isDebugSession()) return;
  // #region agent log
  fetch(DEBUG_INGEST, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": DEBUG_SESSION,
    },
    body: JSON.stringify({
      sessionId: DEBUG_SESSION,
      location,
      message,
      data,
      hypothesisId,
      timestamp: Date.now(),
      runId: process.env.BOT_DEBUG_RUN_ID ?? "debug",
    }),
  }).catch(() => {});
  // #endregion
}

/**
 * Programmatic breakpoint anchor — also set IDE breakpoints on these lines.
 * Active only when BOT_DEBUG_BREAK=1; filter sites via BOT_DEBUG_SITES.
 */
export function debugBreak(site: DebugSite, data: Record<string, unknown> = {}): void {
  if (!isDebugSession() || !siteEnabled(site)) return;
  if (process.env.BOT_DEBUG_BREAK !== "1") return;
  debugLog(`debugBreak:${site}`, `breakpoint:${site}`, data, site);
  debugger;
}
