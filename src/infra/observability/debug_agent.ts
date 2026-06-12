/** Session-scoped agent debug logging (NDJSON ingest). */
export function agentDebugLog(
  location: string,
  message: string,
  data: Record<string, unknown>,
  hypothesisId: string,
  runId = process.env.AGENT_DEBUG_RUN_ID ?? "iteration-2",
): void {
  // #region agent log
  fetch("http://127.0.0.1:7263/ingest/ac6c9208-c536-42e7-b496-db8499c17483", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "135ce6" },
    body: JSON.stringify({
      sessionId: "135ce6",
      runId,
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
}
