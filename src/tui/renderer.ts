import type { TuiLayout, PanelRect } from "./layout.ts";
import type { TuiState } from "./state.ts";

const ESC = "\x1b";

function cursor(row: number, col: number): string {
  return `${ESC}[${row + 1};${col + 1}H`;
}

function hideCursor(): string {
  return `${ESC}[?25l`;
}

function showCursor(): string {
  return `${ESC}[?25h`;
}

function enterAltScreen(): string {
  return `${ESC}[?1049h`;
}

function exitAltScreen(): string {
  return `${ESC}[?1049l`;
}

function bold(text: string): string {
  return `${ESC}[1m${text}${ESC}[22m`;
}

function dim(text: string): string {
  return `${ESC}[2m${text}${ESC}[22m`;
}

function color(text: string, code: number): string {
  return `${ESC}[${code}m${text}${ESC}[0m`;
}

function visibleLength(str: string): number {
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "").length;
}

function visibleSlice(str: string, width: number): string {
  let result = "";
  let len = 0;
  let i = 0;
  while (i < str.length && len < width) {
    if (str[i] === "\x1b") {
      const match = str.slice(i).match(/^\x1b\[[0-9;]*[a-zA-Z]/);
      if (match) {
        result += match[0];
        i += match[0].length;
        continue;
      }
    }
    result += str[i];
    len++;
    i++;
  }
  // Ensure we reset any open color tags if we truncated
  if (i < str.length) {
    result += "\x1b[0m";
  }
  return result;
}

function padRight(str: string, width: number): string {
  const len = visibleLength(str);
  if (len >= width) return visibleSlice(str, width);
  return str + " ".repeat(width - len);
}

const GREEN = 32;
const YELLOW = 33;
const RED = 31;
const CYAN = 36;
const WHITE = 37;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_MOD = 3;

const SECTION_COLORS: Record<string, number> = {
  Index: CYAN, Mempool: YELLOW, Routing: WHITE, Graph: CYAN, Opps: GREEN, Exec: GREEN,
  System: WHITE, Stage: CYAN, Status: YELLOW,
};

class Animator {
  constructor(private _frame: number = 0) {}

  spinner(active: boolean): string {
    if (!active) return "●";
    return SPINNER_FRAMES[Math.floor(this._frame / SPINNER_MOD) % SPINNER_FRAMES.length];
  }

  progressBar(current: number, total: number, width: number): string {
    if (total <= 0) return "";
    const filled = Math.round((current / total) * width);
    return "█".repeat(filled) + "░".repeat(width - filled);
  }

  sparkline(values: number[], width: number): string {
    if (values.length < 2) return "";
    const chars = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
    const recent = values.slice(-width);
    const max = Math.max(...recent.map(Math.abs), 1);
    return recent.map((v) => chars[Math.min(Math.floor((Math.abs(v) / max) * (chars.length - 1)), chars.length - 1)]).join("");
  }

  sectionLabel(emoji: string, label: string): string {
    return bold(`${emoji} ${label}`);
  }
}

interface RenderedPanel {
  y: number;
  content: string;
}

export class Renderer {
  private stdout: { write(s: string): void };
  private initialized = false;

  constructor(stdout: { write(s: string): void; columns: number; rows: number }) {
    this.stdout = stdout;
  }

  enter(): void {
    let buf = "";
    buf += enterAltScreen();
    buf += hideCursor();
    buf += `${ESC}[2J`; // clear entire screen once on enter
    this.stdout.write(buf);
    this.initialized = true;
  }

  exit(): void {
    if (!this.initialized) return;
    let buf = "";
    buf += showCursor();
    buf += exitAltScreen();
    this.stdout.write(buf);
    this.initialized = false;
  }

  render(layout: TuiLayout, state: TuiState, frameCount: number = 0, focusedSection: number = -1): void {
    const animator = new Animator(frameCount);
    const renderFns = [
      this.renderIndexPanel.bind(this),
      this.renderMempoolPanel.bind(this),
      this.renderOpportunitiesPanel.bind(this),
      this.renderRoutingPanel.bind(this),
      this.renderGraphPanel.bind(this),
      this.renderExecutionPanel.bind(this),
    ];

    const panels: RenderedPanel[] = [];
    panels.push(this.renderHeader(layout, state));
    for (let i = 0; i < 6; i++) {
      const lines = renderFns[i](layout.panels[i], state, animator);
      panels.push(this.panelBox(lines, layout.panels[i], i === focusedSection));
    }
    panels.push(this.renderLog(layout, state));
    panels.push(this.renderStatusBar(layout, state));

    let buf = "";
    for (const panel of panels) {
      buf += panel.content;
    }
    this.stdout.write(buf);
  }

  private renderHeader(layout: TuiLayout, state: TuiState): RenderedPanel {
    const running = state.isRunning ? color("[● RUNNING]", GREEN) : color("[○ PAUSED]", RED);
    const uptime = formatUptime(state._startTime > 0 ? Date.now() - state._startTime : 0);
    const m = state.metrics;
    const profit = formatWei(m.totalProfitWei);
    const usd = formatUsd(m.totalProfitWei, state.system.maticPriceUsd);

    const leftText = ` ${bold("Polygon Arb Bot")} (Chain 137)  ${running} `;
    const rightText = ` Uptime: ${uptime} | Total P/L: +${profit} MATIC (${usd}) | Errors: ${m.totalErrors} `;

    const rawLeftLen = visibleLength(leftText);
    const rawRightLen = visibleLength(rightText);
    const padding = Math.max(0, layout.header.width - rawLeftLen - rawRightLen);

    const line = leftText + " ".repeat(padding) + rightText;

    return {
      y: layout.header.y,
      content: cursor(layout.header.y, layout.header.x) + padRight(line, layout.header.width),
    };
  }

  private renderIndexPanel(_rect: PanelRect, state: TuiState, animator: Animator): string[] {
    const s = state.system;
    const statusIcon = s.hiStatus === "syncing" ? "⠋" : s.hiStatus === "synced" ? "●" : "○";
    const blockStr = s.hiSyncedBlock > 0 ? formatBlock(s.hiSyncedBlock) : "—";
    const remoteStr = s.hiRemoteBlock > 0 ? formatBlock(s.hiRemoteBlock) : "—";
    const lag = s.hiLag > 0 ? s.hiLag : (s.hiRemoteBlock > 0 && s.hiSyncedBlock > 0 ? s.hiRemoteBlock - s.hiSyncedBlock : 0);
    const lagColor = lag > 500 ? RED : lag > 50 ? YELLOW : GREEN;

    let pct = 0;
    if (s.hiRemoteBlock > 0 && s.hiSyncedBlock > 0) {
      pct = Math.min(100, Math.floor((s.hiSyncedBlock / s.hiRemoteBlock) * 100));
    }
    const bar = animator.progressBar(s.hiSyncedBlock, s.hiRemoteBlock, 12);
    const mode = s.hiDiscoveryMode ?? "broad";
    const rlPain = (s.hiRateLimitPain ?? 0) > 0 ? `  RL:${s.hiRateLimitPain}` : "";

    return [
      ` ${animator.sectionLabel("📡", "Index")}`,
      ` ${statusIcon} Block: ${color(blockStr, CYAN)} / ${remoteStr} ${dim(s.hiStatus)}`,
      ` ${bar} ${color(`${pct}%`, GREEN)} ${dim("lag:")}${color(String(lag), lagColor)}${s.hiSyncRate > 0 ? dim(` @${s.hiSyncRate.toFixed(1)}/s`) : ""}`,
      ` Mode: ${mode}${rlPain}`,
    ];
  }

  private renderMempoolPanel(_rect: PanelRect, state: TuiState, animator: Animator): string[] {
    const s = state.system;
    const feedIcon = s.mempoolFeedStatus === "connected" ? color("●", GREEN) : s.mempoolFeedStatus === "disconnected" ? color("⊗", RED) : "○";
    const feedLabel = s.mempoolFeedStatus === "connected" ? "active" : s.mempoolFeedStatus;
    const now = Date.now();
    const activeSwaps = s.pendingSwaps.filter((sw) => now - sw.timestamp < 2000);
    const swapLines = activeSwaps.slice(0, 2)
      .map((sw) => ` +${sw.path} ${color(formatWei(BigInt(sw.value)), YELLOW)}`);

    return [
      ` ${animator.sectionLabel("🖄", "Mempool")}`,
      ` ${feedIcon} Subscribed: 1 feed ${dim(feedLabel)}`,
      ...(swapLines.length > 0 ? swapLines : [` ${dim("No pending activity")}`]),
    ];
  }

  private renderOpportunitiesPanel(_rect: PanelRect, state: TuiState, animator: Animator): string[] {
    const s = state.system;
    const isSim = s.pipelineStage === "SIMULATING";
    const spin = animator.spinner(isSim);
    const bar = isSim && s.simProgress.total > 0
      ? animator.progressBar(s.simProgress.current, s.simProgress.total, 12)
      : "";
    const pct = s.simProgress.total > 0 ? ` ${Math.floor((s.simProgress.current / s.simProgress.total) * 100)}%` : "";
    const simLine = isSim
      ? ` ${spin} ${s.simProgress.current}/${s.simProgress.total} [${bar}]${pct}`
      : ` ● ${dim("Idle")}`;

    const best = state.metrics.opportunitiesFound > 0 && state.system.activeOpportunities.length > 0
      ? state.system.activeOpportunities[0]
      : null;
    const topPath = best ? ` ${best.path.padEnd(24)} ${color(formatWei(best.profit), GREEN)}` : dim(" Waiting for opportunities");

    const profitableCount = state.metrics.opportunitiesFound;
    const bestProfit = best ? ` Best: ${color(formatWei(best.profit), GREEN)}` : "";

    return [
      ` ${animator.sectionLabel("💰", "Opportunities")}`,
      simLine,
      ` ★ ${profitableCount} profitable${bestProfit}`,
      topPath,
    ];
  }

  private renderRoutingPanel(_rect: PanelRect, state: TuiState, animator: Animator): string[] {
    const s = state.system;
    const isEnum = s.pipelineStage === "ENUMERATING";
    const spin = animator.spinner(isEnum);
    const cycleInfo = s.cycleCount > 0
      ? `${s.cycleCount.toLocaleString()} cycles`
      : dim("—");
    const enumTime = s.enumerationTimeMs > 0 ? dim(` (${s.enumerationTimeMs}ms)`) : "";

    const hopParts = Object.entries(s.cyclesByHop)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([hop, count]) => `${count} ${hop}-hop`);
    const hopLine = hopParts.length > 0 ? hopParts.join(" | ") : dim("No cycles yet");

    return [
      ` ${animator.sectionLabel("🔀", "Routing")}`,
      ` ${spin} ${cycleInfo}${enumTime}`,
      ` ${hopLine}`,
      ` ${s.cycleCount > 0 ? `${Object.keys(s.cyclesByHop).length} hop types` : dim("Waiting for enumeration")}`,
    ];
  }

  private renderGraphPanel(_rect: PanelRect, state: TuiState, animator: Animator): string[] {
    const s = state.system;
    const isBuild = s.pipelineStage === "LF_REFRESH" || s.pipelineStage === "DISCOVERY";
    const spin = animator.spinner(isBuild);
    const protoParts = Object.entries(s.protocolBreakdown)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 2)
      .map(([name, count]) => `${name}:${count}`);
    const protoLine = protoParts.length > 0 ? protoParts.join(" ") : dim("—");

    return [
      ` ${animator.sectionLabel("🔗", "Graph")}`,
      ` ${spin} ${color(String(s.poolCount), WHITE)} pools | ${s.edgeCount} edges`,
      ` ${protoLine}`,
      ` ${s.cachedStateCount > 0 ? `${s.cachedStateCount} state cached` : dim("No cached state")}`,
    ];
  }

  private renderExecutionPanel(_rect: PanelRect, state: TuiState, animator: Animator): string[] {
    const m = state.metrics;
    const s = state.system;
    const isExec = s.pipelineStage === "EXECUTING";
    const spin = animator.spinner(isExec);
    const successRate = m.executed > 0 ? Math.round((m.successful / m.executed) * 100) : 0;

    const lastExec = s.lastExecution;
    const lastLine = lastExec
      ? ` ${lastExec.path} ${color(lastExec.txHash.slice(0, 8), CYAN)} ${color(formatWei(lastExec.profit), lastExec.success ? GREEN : RED)}`
      : dim(" No executions yet");

    const pl = formatWei(m.totalProfitWei);
    const spark = animator.sparkline(s.profitSparkline, 10);

    return [
      ` ${animator.sectionLabel("⚡", "Execution")}`,
      ` ${spin} ${m.executed} att. ${color(`${m.successful} ✅`, GREEN)} ${m.failed > 0 ? color(`${m.failed} ❌`, RED) : "0 ❌"}`,
      lastLine,
      ` P/L: ${color(pl, m.totalProfitWei >= 0n ? GREEN : RED)} ${spark} win ${successRate}%`,
    ];
  }

  private renderLog(layout: TuiLayout, state: TuiState): RenderedPanel {
    const visibleCount = Math.max(0, layout.log.height - 1);
    const startIdx = Math.max(0, state.log.length - visibleCount);
    const visible = state.log.slice(startIdx, startIdx + visibleCount);
    const lines: string[] = [bold("📋 Event Log")];
    for (const entry of visible) {
      const time = entry.time.toLocaleTimeString("en-US", { hour12: false });
      const compColor = SECTION_COLORS[entry.component] ?? WHITE;
      const comp = color(entry.component.padEnd(8).slice(0, 8), compColor);
      lines.push(` ${dim(time)} ${comp} ${entry.message}`);
    }
    while (lines.length < layout.log.height) {
      lines.push("");
    }
    return this.panelBox(lines, layout.log);
  }

  private renderStatusBar(layout: TuiLayout, state: TuiState): RenderedPanel {
    const s = state.system;
    const rpcIcon = s.rpcConnected ? color("●", GREEN) : color("○", RED);
    const hasuraIcon = s.hasuraConnected ? color("●", GREEN) : color("○", RED);
    const wsIcon = s.wsConnected ? color("●", GREEN) : color("○", RED);
    const hiBlock = s.hiSyncedBlock > 0 ? formatBlock(s.hiSyncedBlock) : "—";

    const left = ` RPC ${rpcIcon} Hasura ${hasuraIcon} WS ${wsIcon} Index:${hiBlock}`;
    const right = ` ${dim("1-6:Tab Focus Q:Quit P:Pause R:Reset")}`;
    const padding = Math.max(0, layout.statusBar.width - visibleLength(left) - visibleLength(right));
    return {
      y: layout.statusBar.y,
      content: cursor(layout.statusBar.y, layout.statusBar.x) + padRight(left + " ".repeat(padding) + right, layout.statusBar.width),
    };
  }

  private panelBox(lines: string[], rect: PanelRect, focused: boolean = false): RenderedPanel {
    let content = "";
    for (let i = 0; i < rect.height; i++) {
      const rawLine = lines[i] ?? "";
      const line = focused ? color(rawLine, CYAN) : rawLine;
      content += cursor(rect.y + i, rect.x);
      content += padRight(line, rect.width);
    }
    return { y: rect.y, content };
  }
}

function formatWei(wei: bigint): string {
  const eth = Number(wei) / 1e18;
  return eth < 0.001 ? eth.toFixed(6) : eth.toFixed(4);
}

function formatUsd(wei: bigint, maticPriceUsd: number): string {
  const matic = Number(wei) / 1e18;
  const usd = matic * maticPriceUsd;
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatBlock(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatUptime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}


