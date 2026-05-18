const ESC = "\x1b";
const CSI = `${ESC}[`;
const RESET = `${CSI}0m`;
const BOLD = `${CSI}1m`;
const DIM = `${CSI}2m`;
const RED = `${CSI}31m`;
const GREEN = `${CSI}32m`;
const YELLOW = `${CSI}33m`;
const BLUE = `${CSI}34m`;
const MAGENTA = `${CSI}35m`;
const CYAN = `${CSI}36m`;
const WHITE = `${CSI}37m`;
const CURSOR_HIDE = `${CSI}?25l`;
const CURSOR_SHOW = `${CSI}?25h`;
const HOME = `${CSI}H`;
const CLEAR = `${CSI}J`;

const MAX_OPPORTUNITIES = 5;
const MAX_LOGS = 20;
const REFRESH_INTERVAL_MS = 1_000;

export interface BotOpportunityRow {
  Route: string;
  Profit: string;
  ROI: string;
}

export interface BotActivityProgress {
  completed?: number;
  total?: number;
  unit?: string;
  label?: string;
}

export interface BotState {
  status: "idle" | "running" | "error";
  mode: string;
  passCount: number;
  consecutiveErrors: number;
  gasPrice: string;
  lastArbMs: number;
  stateCacheSize?: number;
  cachedPathCount?: number;
  lastPassDurationMs?: number;
  lastOpportunityCount?: number;
  lastPathsEvaluated?: number;
  lastCandidateCount?: number;
  lastShortlistCount?: number;
  lastOptimizedCount?: number;
  lastProfitableCount?: number;
  lastUpdateMs?: number;
  currentActivity?: string;
  currentActivityDetail?: string;
  currentActivityUpdatedMs?: number;
  currentActivityProgress?: BotActivityProgress | null;
  opportunities: BotOpportunityRow[];
  logs: string[];
  totalTxAttempted: number;
  totalTxSuccessful: number;
  totalTxReverted: number;
  totalProfitWei?: bigint;
  lastProfitWei?: bigint;
  lastTxSuccessRate?: number;
  lastTxSuccessRateMs?: number;
}

let _state: BotState | null = null;
let _renderVersion = 0;

function termWidth() {
  return Math.min(process.stdout.columns || 100, 120);
}

function trunc(s: string, n: number) {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)) + "\u2026";
}

function pad(s: string, n: number) {
  if (s.length >= n) return s;
  return s + " ".repeat(n - s.length);
}

function age(ts: number | undefined, now: number) {
  if (!ts || ts <= 0) return "never";
  const a = Math.max(0, now - ts);
  if (a < 1_000) return "now";
  if (a < 60_000) return `${Math.floor(a / 1_000)}s ago`;
  if (a < 3_600_000) return `${Math.floor(a / 60_000)}m ago`;
  return `${Math.floor(a / 3_600_000)}h ago`;
}

function fmt(n: number | undefined) {
  if (n == null || !Number.isFinite(n)) return "0";
  return Math.trunc(n).toLocaleString("en-US");
}

function fmtDur(ms: number | undefined) {
  if (ms == null || ms <= 0) return "n/a";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1_000);
  return `${m}m ${s}s`;
}

function fmtWei(value: bigint | undefined) {
  if (!value || value === 0n) return "0";
  const ether = value / 1_000_000_000_000_000_000n;
  const gwei = (value % 1_000_000_000_000_000_000n) / 1_000_000_000n;
  return ether > 0 ? `${ether.toString()} MATIC` : `${gwei.toString()} GWEI`;
}

function statusStyle(status: string) {
  const color = status === "running" ? GREEN : status === "error" ? RED : YELLOW;
  const label = status === "running" ? "RUN" : status === "error" ? "ERR" : "IDLE";
  return `${color}${BOLD}[${label}]${RESET}`;
}

function fmtProgress(p: BotActivityProgress | null | undefined) {
  if (!p) return null;
  const parts: string[] = [];
  if (p.label) parts.push(p.label);
  if (p.completed != null && p.total != null) parts.push(`${fmt(p.completed)}/${fmt(p.total)}`);
  else if (p.completed != null) parts.push(fmt(p.completed));
  else if (p.total != null) parts.push(`0/${fmt(p.total)}`);
  if (p.unit) parts.push(p.unit);
  return parts.length > 0 ? parts.join(" ") : null;
}

function logTone(line: string) {
  if (line.includes("[FATAL]") || line.includes("[ERROR]")) return RED;
  if (line.includes("[WARN]")) return YELLOW;
  if (line.includes("[DEBUG]")) return BLUE;
  return WHITE;
}

function normLog(line: string) {
  return line
    .replace(/\s+/g, " ")
    .replace(/topReject=net profit ([^|]+)/g, "topReject=net_profit $1")
    .trim();
}

function logSeverity(logs: string[]) {
  let err = 0, warn = 0, info = 0, dbg = 0;
  for (const l of logs) {
    if (l.includes("[ERROR]") || l.includes("[FATAL]")) err++;
    else if (l.includes("[WARN]")) warn++;
    else if (l.includes("[DEBUG]")) dbg++;
    else info++;
  }
  return { err, warn, info, dbg };
}

function latestMatch(logs: string[], pattern: RegExp) {
  for (const line of logs) {
    const m = normLog(line).match(pattern);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

function latestEvent(logs: string[]) {
  for (const line of logs) {
    const m = normLog(line).match(/^\[[^\]]+\]\s+([a-z][a-z0-9_]*)/i);
    if (m?.[1]) return m[1];
  }
  return "none";
}

function metric(label: string, value: string, color = WHITE, w = 22) {
  return `${DIM}${label}${RESET} ${color}${trunc(value, w - label.length - 2)}${RESET}`;
}

function metricRow(metrics: { label: string; value: string; color?: string }[]) {
  const w = termWidth();
  const segW = Math.max(16, Math.floor(w / metrics.length));
  const parts = metrics.map((m) => pad(metric(m.label, m.value, m.color || WHITE, segW), segW));
  return ` ${parts.join("")}`;
}

function renderFrame(state: BotState, now: number): string {
  const w = termWidth();
  const h = process.stdout.rows || 30;
  const signal = latestEvent(state.logs);
  const topReject = latestMatch(state.logs, /topReject=([^|]+)/) ?? "none";
  const missing = latestMatch(state.logs, /missingRates=(\d+)/) ?? "0";
  const sev = logSeverity(state.logs);
  const updated = state.lastUpdateMs || state.lastArbMs || 0;
  const oppCount = state.lastOpportunityCount ?? state.opportunities.length;
  const txRate = state.lastTxSuccessRate;
  const rateColor = !txRate ? WHITE : txRate >= 0.9 ? GREEN : txRate >= 0.7 ? YELLOW : RED;

  const topLines: string[] = [];

  topLines.push(` ${CYAN}${BOLD}ARB${RESET}  ${BOLD}Polygon Arbitrage Bot${RESET}  ${DIM}Live execution monitor${RESET}`);
  topLines.push(` ${statusStyle(state.status)} ${state.status.toUpperCase()}`);

  const act = state.currentActivity || "Idle";
  const det = state.currentActivityDetail || "";
  const prog = fmtProgress(state.currentActivityProgress);
  let al = ` ${GREEN}${act}${RESET}`;
  if (prog) al += ` ${CYAN}${prog}${RESET}`;
  al += ` ${DIM}(${age(state.currentActivityUpdatedMs, now)})${RESET}`;
  topLines.push(al);
  if (det) topLines.push(` ${DIM}${trunc(det, w - 2)}${RESET}`);
  topLines.push("");

  topLines.push(
    metricRow([
      { label: "mode", value: state.mode, color: CYAN },
      { label: "passes", value: fmt(state.passCount), color: CYAN },
      { label: "errors", value: `${state.consecutiveErrors}`, color: state.consecutiveErrors > 0 ? RED : GREEN },
      { label: "last", value: fmtDur(state.lastPassDurationMs) },
    ]),
  );

  topLines.push(
    metricRow([
      { label: "gas", value: `${state.gasPrice} gwei`, color: YELLOW },
      { label: "eval", value: fmt(state.lastPathsEvaluated), color: CYAN },
      { label: "candidates", value: fmt(state.lastCandidateCount), color: CYAN },
      { label: "optimized", value: fmt(state.lastOptimizedCount), color: CYAN },
    ]),
  );

  topLines.push(
    metricRow([
      { label: "pools", value: fmt(state.stateCacheSize), color: CYAN },
      { label: "paths", value: fmt(state.cachedPathCount), color: CYAN },
      { label: "opps", value: fmt(oppCount), color: oppCount > 0 ? GREEN : WHITE },
      { label: "updated", value: age(updated, now) },
    ]),
  );

  topLines.push(
    metricRow([
      { label: "signal", value: signal, color: CYAN },
      { label: "reject", value: topReject, color: topReject === "none" ? GREEN : YELLOW },
      { label: "missing", value: missing, color: missing === "0" ? GREEN : YELLOW },
      { label: "", value: ``, color: WHITE },
    ]),
  );

  const txColor = sev.err > 0 ? RED : sev.warn > 0 ? YELLOW : GREEN;
  topLines.push(
    metricRow([
      {
        label: "tx",
        value: `att ${fmt(state.totalTxAttempted)} ok ${fmt(state.totalTxSuccessful)} (${txRate ? (txRate * 100).toFixed(1) : "0"}%) rv ${fmt(state.totalTxReverted)}`,
        color: rateColor,
      },
      { label: "", value: ``, color: WHITE },
      { label: "logs", value: `${sev.err}E/${sev.warn}W/${sev.info}I`, color: txColor },
      { label: "profit", value: fmtWei(state.totalProfitWei), color: GREEN },
    ]),
  );
  topLines.push("");

  topLines.push(` ${DIM}${"\u2500".repeat(Math.min(w - 2, 100))}${RESET}`);
  topLines.push("");

  if (state.opportunities.length === 0) {
    topLines.push(` ${DIM}No opportunities found yet.${RESET}`);
  } else {
    topLines.push(` ${MAGENTA}${BOLD}Top Opportunities${RESET}`);
    for (let i = 0; i < Math.min(state.opportunities.length, MAX_OPPORTUNITIES); i++) {
      const o = state.opportunities[i];
      const route = trunc(o.Route || "n/a", 30);
      const profit = trunc(o.Profit || "n/a", 22);
      const roi = trunc(o.ROI || "n/a", 10);
      topLines.push(
        ` ${CYAN}${String(i + 1).padStart(2, "0")}${RESET} ${pad(route, 30)} ${GREEN}${pad(profit, 22)}${RESET} ${MAGENTA}${roi}${RESET}`,
      );
    }
  }
  topLines.push("");

  const overhead = topLines.length + 1;
  const maxLogLines = Math.max(1, h - overhead);
  const logLineCount = Math.min(MAX_LOGS, maxLogLines);

  const logSection: string[] = [];
  logSection.push(` ${BLUE}${BOLD}Recent Logs${RESET}`);
  const recentLogs = state.logs.slice(0, logLineCount);
  if (recentLogs.length === 0) {
    logSection.push(` ${DIM}No logs yet.${RESET}`);
  } else {
    for (const line of recentLogs) {
      logSection.push(` ${logTone(line)}${trunc(normLog(line), w - 3)}${RESET}`);
    }
  }
  while (logSection.length < 1 + logLineCount) {
    logSection.push("");
  }

  const lines: string[] = [`${HOME}${CLEAR}`, ...topLines, ...logSection];

  return lines.join("\n");
}

let _timer: ReturnType<typeof setInterval> | null = null;

export function startTui(state: BotState): () => void {
  if (!process.stdout.isTTY) return () => {};
  _state = state;

  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  stdin.setRawMode?.(true);
  stdin.resume();

  const onData = (data: Buffer) => {
    const key = data.toString();
    if (key.toLowerCase() === "q" || key === "\x03") {
      process.kill(process.pid, "SIGINT");
    }
  };
  stdin.on("data", onData);

  let lastRenderedVersion = 0;

  function tick() {
    if (!_state) return;
    if (_renderVersion === lastRenderedVersion) return;
    lastRenderedVersion = _renderVersion;
    const frame = renderFrame(_state, Date.now());
    process.stdout.write(frame);
  }

  process.stdout.write(CURSOR_HIDE);
  tick();
  _timer = setInterval(tick, REFRESH_INTERVAL_MS);
  _timer.unref();

  process.on("SIGWINCH", () => {
    lastRenderedVersion = -1;
    tick();
  });

  return () => {
    if (_timer) {
      clearInterval(_timer);
      _timer = null;
    }
    process.stdout.write(`${CURSOR_SHOW}\n`);
    stdin.setRawMode?.(wasRaw ?? false);
    stdin.pause();
    stdin.removeListener("data", onData);
    process.removeListener("SIGWINCH", tick);
    _state = null;
  };
}

export function updateState(state: BotState) {
  _state = state;
  _renderVersion++;
}
