import type { TuiLayout, PanelRect } from "./layout.ts";
import type { TuiState } from "./state.ts";

// ─── ANSI helpers ────────────────────────────────────────────────────────────

const ESC = "\x1b";

const C = {
  reset: `${ESC}[0m`,
  bold: (s: string) => `${ESC}[1m${s}${ESC}[22m`,
  dim: (s: string) => `${ESC}[2m${s}${ESC}[22m`,
  fg: (s: string, code: number) => `${ESC}[${code}m${s}${ESC}[0m`,
  bg: (s: string, fgCode: number, bgCode: number) => `${ESC}[${fgCode};${bgCode}m${s}${ESC}[0m`,
  cursor: (row: number, col: number) => `${ESC}[${row + 1};${col + 1}H`,
  hideCursor: () => `${ESC}[?25l`,
  showCursor: () => `${ESC}[?25h`,
  altOn: () => `${ESC}[?1049h`,
  altOff: () => `${ESC}[?1049l`,
  clearScreen: () => `${ESC}[2J`,
};

// Named colour codes
const GREEN = 32;
const YELLOW = 33;
const RED = 31;
const CYAN = 36;
const WHITE = 37;
const MAGENTA = 35;
const BLUE = 34;

// Component → colour mapping for the log panel
const COMP_COLORS: Record<string, number> = {
  Index: CYAN,
  Indexer: CYAN,
  Mempool: YELLOW,
  Routing: WHITE,
  Graph: CYAN,
  Opps: GREEN,
  Exec: GREEN,
  System: WHITE,
  Stage: CYAN,
  Status: YELLOW,
  Discovery: MAGENTA,
  Pipeline: GREEN,
  Trace: GREEN,
  TraceWarn: YELLOW,
  Log: WHITE,
  Info: CYAN,
  Warn: YELLOW,
  Error: RED,
  Debug: BLUE,
};

// ─── String utilities ─────────────────────────────────────────────────────────

/** Strip ANSI escape sequences to get visible character count */
function visLen(s: string): number {
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "").length;
}

/** Slice a string to `width` *visible* characters, preserving and closing ANSI codes */
function visTrunc(s: string, width: number): string {
  let result = "";
  let len = 0;
  let i = 0;
  while (i < s.length && len < width) {
    if (s[i] === "\x1b") {
      const m = s.slice(i).match(/^\x1b\[[0-9;]*[a-zA-Z]/);
      if (m) {
        result += m[0];
        i += m[0].length;
        continue;
      }
    }
    result += s[i];
    len++;
    i++;
  }
  if (i < s.length) result += "\x1b[0m"; // close open tags
  return result;
}

/** Pad/truncate to exactly `width` visible chars */
function padR(s: string, width: number, char = " "): string {
  const l = visLen(s);
  if (l >= width) return visTrunc(s, width);
  return s + char.repeat(width - l);
}

// ─── Animation helpers ────────────────────────────────────────────────────────

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPIN_DIV = 3; // frames per spinner tick

function spinner(frame: number, active: boolean): string {
  if (!active) return "●";
  return SPINNER[Math.floor(frame / SPIN_DIV) % SPINNER.length];
}

function progressBar(current: number, total: number, width: number): string {
  if (total <= 0 || width <= 0) return "░".repeat(width);
  const filled = Math.min(width, Math.round((current / total) * width));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

// ─── Format helpers ────────────────────────────────────────────────────────────

function abbreviateProtocol(name: string): string {
  const map: Record<string, string> = {
    UniswapV2: "UniV2",
    UniswapV3: "UniV3",
    BalancerVault: "Bal",
    CurveFactory: "Crv",
    DodoFactory: "Dodo",
    WooFi: "Woo",
    UniswapV4: "UniV4",
  };
  return map[name] ?? name;
}

function fmtWeiMatic(wei: bigint): string {
  const n = Number(wei) / 1e18;
  if (n === 0) return "0";
  if (Math.abs(n) < 0.0001) return n.toFixed(6);
  if (Math.abs(n) < 0.01) return n.toFixed(5);
  return n.toFixed(4);
}

function fmtUsd(wei: bigint, maticUsd: number): string {
  const usd = (Number(wei) / 1e18) * maticUsd;
  if (usd === 0) return "$0";
  if (Math.abs(usd) < 0.01) return `$${usd.toFixed(4)}`;
  if (Math.abs(usd) < 100) return `$${usd.toFixed(2)}`;
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtBlock(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
}

function fmtGwei(wei: bigint): string {
  const gwei = Number(wei) / 1e9;
  return gwei < 10 ? gwei.toFixed(2) : gwei.toFixed(1);
}

function fmtPct(n: number, d: number): string {
  return d > 0 ? `${Math.round((n / d) * 100)}%` : "—";
}

// ─── Renderer ─────────────────────────────────────────────────────────────────

interface RenderedPanel {
  content: string;
}

export class Renderer {
  private stdout: { write(s: string): void };
  private initialized = false;

  constructor(stdout: { write(s: string): void; columns: number; rows: number }) {
    this.stdout = stdout;
  }

  enter(): void {
    this.stdout.write(C.altOn() + C.hideCursor() + C.clearScreen());
    this.initialized = true;
  }

  exit(): void {
    if (!this.initialized) return;
    this.stdout.write(C.showCursor() + C.altOff());
    this.initialized = false;
  }

  render(layout: TuiLayout, state: TuiState, frameCount = 0, focusedSection = -1): void {
    const frame = frameCount;
    const panels: RenderedPanel[] = [];

    panels.push(this._header(layout, state));

    const renderFns = [
      this._panelIndex.bind(this),
      this._panelMempool.bind(this),
      this._panelOpportunities.bind(this),
      this._panelRouting.bind(this),
      this._panelGraph.bind(this),
      this._panelExecution.bind(this),
    ];

    const titles = ["Index", "Mempool", "Opportunities", "Routing", "Graph", "Execution"];

    for (let i = 0; i < 6; i++) {
      const lines = renderFns[i](layout.panels[i], state, frame);
      panels.push(this._box(lines, layout.panels[i], titles[i], i === focusedSection));
    }

    panels.push(this._log(layout, state));
    panels.push(this._statusBar(layout, state));

    let buf = "";
    for (const p of panels) buf += p.content;
    this.stdout.write(buf);
  }

  // ── Header ─────────────────────────────────────────────────────────────────

  private _header(layout: TuiLayout, state: TuiState): RenderedPanel {
    const m = state.metrics;
    const running = state.isRunning ? (state.isPaused ? C.fg("[⏸ PAUSED]", YELLOW) : C.fg("[● RUNNING]", GREEN)) : C.fg("[○ STOPPED]", RED);
    const uptime = fmtUptime(state._startTime > 0 ? Date.now() - state._startTime : 0);
    const profit = fmtWeiMatic(m.totalProfitWei);
    const usd = fmtUsd(m.totalProfitWei, state.system.maticPriceUsd);
    const winRate = fmtPct(m.successful, m.executed);
    const cpm = m.cyclesPerMin > 0 ? `${m.cyclesPerMin}cpm` : "—";

    const left = ` ${C.bold("Polygon Arb Bot")} (Chain 137)  ${running} `;
    const right = ` ⏱ ${uptime} | P/L: ${C.fg(`${m.totalProfitWei >= 0n ? "+" : ""}${profit} MATIC`, m.totalProfitWei >= 0n ? GREEN : RED)} (${usd}) | Win: ${winRate} | ${cpm} | Err: ${m.totalErrors} `;

    const gap = Math.max(0, layout.header.width - visLen(left) - visLen(right));
    const line = left + " ".repeat(gap) + right;

    return {
      content: C.cursor(layout.header.y, layout.header.x) + padR(line, layout.header.width),
    };
  }

  // ── Panel 1: Index (HyperIndex / indexer health) ───────────────────────────

  private _panelIndex(_rect: PanelRect, state: TuiState, frame: number): string[] {
    const s = state.system;
    const isSyncing = s.hiStatus === "syncing";
    const spin = spinner(frame, isSyncing);
    const statusColor = s.hiStatus === "synced" ? GREEN : s.hiStatus === "error" ? RED : YELLOW;
    const blockStr = s.hiSyncedBlock > 0 ? fmtBlock(s.hiSyncedBlock) : "—";
    const remoteStr = s.hiRemoteBlock > 0 ? fmtBlock(s.hiRemoteBlock) : "—";
    const lag = s.hiLag > 0 ? s.hiLag : s.hiRemoteBlock > 0 && s.hiSyncedBlock > 0 ? s.hiRemoteBlock - s.hiSyncedBlock : 0;
    const lagColor = lag > 500 ? RED : lag > 50 ? YELLOW : GREEN;
    const pct = s.hiRemoteBlock > 0 && s.hiSyncedBlock > 0 ? Math.min(100, Math.floor((s.hiSyncedBlock / s.hiRemoteBlock) * 100)) : 0;
    const bar = progressBar(s.hiSyncedBlock, s.hiRemoteBlock, 10);

    const ds = s.discoverySummary;
    let summaryLine = ``;
    if (ds) {
      const top2 = Object.entries(ds.protocolBreakdown)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 2)
        .map(([name, count]) => `${abbreviateProtocol(name)}:${count}`)
        .join(" ");
      summaryLine = `${top2} | Lag:${C.fg(String(ds.lagBlocks), ds.lagBlocks > 10 ? RED : GREEN)}`;
    }

    return [
      `${spin} ${C.fg(s.hiStatus, statusColor)} ${C.fg(blockStr, CYAN)}/${remoteStr}`,
      `[${bar}] ${C.fg(`${pct}%`, GREEN)} lag:${C.fg(String(lag), lagColor)}${s.hiSyncRate > 0 ? C.dim(` @${s.hiSyncRate.toFixed(1)}/s`) : ""}`,
      summaryLine,
    ];
  }

  // ── Panel 2: Mempool ────────────────────────────────────────────────────────

  private _panelMempool(_rect: PanelRect, state: TuiState, _frame: number): string[] {
    const s = state.system;
    const feedIcon =
      s.mempoolFeedStatus === "connected" ? C.fg("●", GREEN) : s.mempoolFeedStatus === "disconnected" ? C.fg("⊗", RED) : C.dim("○");
    const feedLabel = s.mempoolFeedStatus;

    const now = Date.now();
    const fresh = s.pendingSwaps.filter((sw) => now - sw.timestamp < 3000);
    const swapLines = fresh.slice(0, 3).map((sw) => {
      const val = (Number(sw.value) / 1e18).toFixed(3);
      return `${C.dim(`[${sw.traceId.slice(0, 6)}]`)} ${sw.path.slice(0, 16)} ${C.fg(val + " M", YELLOW)}`;
    });

    return [
      `${feedIcon} ${C.dim(feedLabel)}`,
      ...(swapLines.length > 0 ? swapLines : [`${C.dim("No recent activity")}`]),
    ];
  }

  // ── Panel 3: Opportunities ─────────────────────────────────────────────────

  private _panelOpportunities(_rect: PanelRect, state: TuiState, frame: number): string[] {
    const s = state.system;
    const m = state.metrics;
    const isSim = s.pipelineStage === "SIMULATING";
    const spin = spinner(frame, isSim);

    // Sim progress line
    let simLine: string;
    if (isSim && s.simProgress.total > 0) {
      const bar = progressBar(s.simProgress.current, s.simProgress.total, 10);
      const pct = Math.floor((s.simProgress.current / s.simProgress.total) * 100);
      simLine = `${spin} ${s.simProgress.current}/${s.simProgress.total} [${bar}] ${pct}% ✦${s.simProgress.profitable}`;
    } else {
      const ss = s.lastSimStats;
      if (ss) {
        simLine = `Attempts: ${ss.attempted} | Simulated: ${ss.simulated}`;
      } else {
        simLine = `${C.dim("● Idle — awaiting simulation")}`;
      }
    }

    const best = m.opportunitiesFound > 0 && s.activeOpportunities.length > 0 ? s.activeOpportunities[0] : null;
    const bestLine = best
      ? `Top Opp: ${C.fg(`${best.profit >= 0n ? "+" : ""}${fmtWeiMatic(best.profit)}`, GREEN)} MATIC`
      : `${C.dim("★ No profitable opportunities yet")}`;
    const countLine = `Found: ${C.fg(String(m.opportunitiesFound), GREEN)} total`;

    return [simLine, bestLine, countLine];
  }

  // ── Panel 4: Routing ────────────────────────────────────────────────────────

  private _panelRouting(_rect: PanelRect, state: TuiState, frame: number): string[] {
    const s = state.system;
    const isEnum = s.pipelineStage === "ENUMERATING";
    const spin = spinner(frame, isEnum);
    const cycleStr = s.cycleCount > 0 ? C.fg(s.cycleCount.toLocaleString(), WHITE) + " cycles" : C.dim("—");
    const enumTime = s.enumerationTimeMs > 0 ? C.dim(` (${s.enumerationTimeMs}ms)`) : "";

    const hopParts = Object.entries(s.cyclesByHop)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([hop, count]) => `${hop}h: ${count}`);
    const hopLine = hopParts.length > 0 ? hopParts.join("  ") : C.dim("—");

    return [`${spin} ${cycleStr}${enumTime}`, hopLine];
  }

  // ── Panel 5: Graph ─────────────────────────────────────────────────────────

  private _panelGraph(_rect: PanelRect, state: TuiState, frame: number): string[] {
    const s = state.system;
    const isBuild = s.pipelineStage === "LF_REFRESH" || s.pipelineStage === "DISCOVERY";
    const spin = spinner(frame, isBuild);

    const protoTop = Object.entries(s.protocolBreakdown)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([name, count]) => `${abbreviateProtocol(name)}:${count}`)
      .join(" ");
    const protoLine = protoTop.length > 0 ? protoTop : C.dim("—");

    const cacheStr = s.cachedStateCount > 0 ? `cache:${s.cachedStateCount.toLocaleString()}` : C.dim("cache: warming");

    return [
      `${spin} ${C.fg(String(s.poolCount), WHITE)} pools  ${s.edgeCount > 0 ? s.edgeCount.toLocaleString() + " edges" : ""}`,
      `${protoLine}`,
      `${cacheStr}`,
    ];
  }

  // ── Panel 6: Execution ─────────────────────────────────────────────────────

  private _panelExecution(_rect: PanelRect, state: TuiState, frame: number): string[] {
    const m = state.metrics;
    const s = state.system;
    const isExec = s.pipelineStage === "EXECUTING";
    const spin = spinner(frame, isExec);

    const successRate = fmtPct(m.successful, m.executed);

    return [
      `${spin} Attempts: ${m.executed} | Success: ${C.fg(String(m.successful), GREEN)}`,
      `Failed: ${C.fg(String(m.failed), m.failed > 0 ? RED : WHITE)} | Reverts: ${C.fg(String(m.reverts), YELLOW)}`,
      `Success Rate: ${successRate}`,
      `Total Profit: ${C.fg(`${m.totalProfitWei >= 0n ? "+" : ""}${fmtWeiMatic(m.totalProfitWei)}`, m.totalProfitWei >= 0n ? GREEN : RED)} MATIC`,
    ];
  }

  // ── Log panel ──────────────────────────────────────────────────────────────

  private _log(layout: TuiLayout, state: TuiState): RenderedPanel {
    const rect = layout.log;
    const visibleRows = Math.max(0, rect.height - 2);
    const startIdx = Math.max(0, state.log.length - visibleRows);
    const visible = state.log.slice(startIdx);

    const lines: string[] = [];
    for (const entry of visible) {
      const compCode = COMP_COLORS[entry.component] ?? WHITE;
      const comp = C.fg(entry.component.padEnd(9).slice(0, 9), compCode);
      lines.push(`${C.dim(entry.time)} ${comp} ${entry.message}`);
    }

    return this._box(lines, rect, "Event Log");
  }

  // ── Status bar ─────────────────────────────────────────────────────────────

  private _statusBar(layout: TuiLayout, state: TuiState): RenderedPanel {
    const s = state.system;
    const m = state.metrics;
    const rect = layout.statusBar;

    const dot = (ok: boolean) => (ok ? C.fg("●", GREEN) : C.fg("○", RED));
    const rpcIcon = dot(s.rpcConnected);
    const hasuraIcon = dot(s.hasuraConnected);
    const wsIcon = dot(s.wsConnected);
    const hiBlock = s.hiSyncedBlock > 0 ? fmtBlock(s.hiSyncedBlock) : "—";
    const gas = s.gasPriceWei > 0n ? `${fmtGwei(s.gasPriceWei)}gw` : "—";
    const cpm = m.cyclesPerMin > 0 ? `${m.cyclesPerMin}cpm` : "—";
    const maxHp = m.maxHotPathMs > 0 ? `max:${m.maxHotPathMs}ms` : "";
    const cramped = layout.cramped ? C.fg(" ⚠ Terminal too small", YELLOW) : "";

    const left = ` RPC${rpcIcon} Hasura${hasuraIcon} WS${wsIcon} idx:${hiBlock} gas:${gas} ${cpm} ${maxHp}${cramped}`;
    const right = C.dim(" 1-6:focus  Tab:cycle  P:pause  R:reset  Q:quit ");
    const gap = Math.max(0, rect.width - visLen(left) - visLen(right));

    return {
      content: C.cursor(rect.y, rect.x) + padR(left + " ".repeat(gap) + right, rect.width),
    };
  }

  // ── Panel box renderer ─────────────────────────────────────────────────────

  private _box(lines: string[], rect: PanelRect, title?: string, focused = false): RenderedPanel {
    let content = "";
    const borderColor = focused ? CYAN : WHITE;

    // 1. Top Border
    let top = "┌─";
    if (title) top += ` ${title} `;
    top = padR(top, rect.width - 1, "─") + "┐";
    content += C.cursor(rect.y, rect.x) + C.fg(top, borderColor);

    // 2. Middle (Content)
    // Content rows are between top and bottom border
    const contentHeight = rect.height - 2;
    const borderColorCode = focused ? ESC + "[36m" : ESC + "[37m";
    for (let i = 0; i < contentHeight; i++) {
      const raw = lines[i] ?? "";
      const line = "│" + padR(" " + raw, rect.width - 2) + borderColorCode + "│";
      content += C.cursor(rect.y + i + 1, rect.x) + C.fg(line, borderColor);
    }

    // 3. Bottom Border
    const bottom = "└" + "─".repeat(rect.width - 2) + "┘";
    content += C.cursor(rect.y + rect.height - 1, rect.x) + C.fg(bottom, borderColor);

    return { content };
  }
}
