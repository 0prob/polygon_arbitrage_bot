/** Cursor/VS Code debug helpers — active when BOT_DEBUG=1 or --debug is passed. */

export const DebugSites = {
  BOOT: "boot",
  PASS_LOOP_START: "pass-loop-start",
  PASS_LOOP_ERROR: "pass-loop-error",
  HF_TICK: "hf-tick",
  PROFITABLE_FOUND: "profitable-found",
  TX_SUBMIT: "tx-submit",
  TX_RESULT: "tx-result",
  PIPELINE_CYCLE_ERROR: "pipeline-cycle-error",
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

/** Programmatic breakpoint anchor — also set IDE breakpoints on these lines. */
export function debugBreak(site: DebugSite, data: Record<string, unknown> = {}): void {
  if (!isDebugSession() || !siteEnabled(site)) return;
  if (process.env.BOT_DEBUG_BREAK !== "1") return;
  debugLog(`debugBreak:${site}`, `breakpoint:${site}`, data, site);
  debugger;
}
