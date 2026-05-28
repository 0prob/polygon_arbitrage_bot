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

  render(layout: TuiLayout, state: TuiState): void {
    const panels: RenderedPanel[] = [];

    panels.push(this.renderHeader(layout, state));
    panels.push(this.renderPipeline(layout, state));
    panels.push(this.renderMainTable(layout, state));
    panels.push(this.renderSidebar(layout, state));
    panels.push(this.renderFooterLog(layout, state));
    panels.push(this.renderKeymap(layout, state));

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

  private renderPipeline(layout: TuiLayout, state: TuiState): RenderedPanel {
    const s = state.system;

    let simProgressStr = "";
    if (s.pipelineStage === "SIMULATING" && s.simProgress.total > 0) {
      const pct = Math.floor((s.simProgress.current / s.simProgress.total) * 100);
      const barLen = 15;
      const filled = Math.floor((pct / 100) * barLen);
      const bar = "=".repeat(filled) + (filled < barLen ? ">" : "") + " ".repeat(Math.max(0, barLen - filled - 1));
      simProgressStr = ` [${bar}] ${pct}% (${s.simProgress.current}/${s.simProgress.total})`;
    }

    const lines = [
      bold("🔄 Pipeline Monitor"),
      `  [${s.pipelineStage === "DISCOVERY" ? color("●", CYAN) : s.poolCount > 0 ? color("✔", GREEN) : " "}] Discovery:   ${s.poolCount} pools`,
      `  [${s.pipelineStage === "ENUMERATING" ? color("●", CYAN) : s.cycleCount > 0 ? color("✔", GREEN) : " "}] Enumerate:   ${s.cycleCount} cycles found`,
      `  [${s.pipelineStage === "SIMULATING" ? color("●", CYAN) : " "}] Simulation:  ${s.pipelineStage === "SIMULATING" ? "Running..." : "Idle"} ${simProgressStr}`,
      `  [${s.pipelineStage === "EXECUTING" ? color("●", YELLOW) : " "}] Execution:   ${s.pipelineStage === "EXECUTING" ? "Submitting TXs..." : "Idle"}`,
      ``,
      `  ${dim(`Last Pass: ${s.lastCycleTimeMs}ms | ${state.metrics.opportunitiesFound} profitable overall`)}`,
    ];
    return this.panelBox(lines, layout.pipeline);
  }

  private renderMainTable(layout: TuiLayout, state: TuiState): RenderedPanel {
    const lines = [
      bold("⭐ Top Opportunities"),
      `  ${dim("Path").padEnd(32)} ${dim("Profit").padEnd(16)} ${dim("USD").padEnd(10)} ${dim("Status")}`,
    ];

    if (state.system.activeOpportunities.length === 0) {
      lines.push(`  ${dim("No active opportunities.")}`);
    } else {
      for (const opp of state.system.activeOpportunities) {
        const profit = formatWei(opp.profit);
        const usd = formatUsd(opp.profit, state.system.maticPriceUsd);
        let statusColor = WHITE;
        if (opp.status === "Confirmed") statusColor = GREEN;
        if (opp.status === "Failed" || opp.status === "Quarantined") statusColor = RED;
        if (opp.status === "Executing") statusColor = YELLOW;

        lines.push(
          `  ${opp.path.padEnd(30)} ${color(profit, CYAN).padEnd(16)} ${color(usd, GREEN).padEnd(10)} ${color(opp.status, statusColor)}`,
        );
      }
    }

    return this.panelBox(lines, layout.mainTable);
  }

  private renderSidebar(layout: TuiLayout, state: TuiState): RenderedPanel {
    const s = state.system;
    const gwei = s.gasPriceWei > 0n ? formatGwei(s.gasPriceWei) : "—";

    let hiLabel: string;
    let hiColor: number;
    const hiLag = s.hiLag > 0 ? ` lag:${s.hiLag}` : (s.hiRemoteBlock > 0 && s.hiSyncedBlock > 0 ? ` lag:${s.hiRemoteBlock - s.hiSyncedBlock}` : "");
    const hiRate = s.hiSyncRate > 0 ? ` @${s.hiSyncRate.toFixed(1)}blk/s` : "";

    if (s.hiSyncedBlock > 0) {
      hiColor = s.hiStatus === "synced" ? GREEN : YELLOW;
      hiLabel = `${color(s.hiStatus, hiColor)} ${color(formatBlock(s.hiSyncedBlock), hiColor)}${dim(hiLag + hiRate)}`;
    } else if (s.hiStatus === "running") {
      hiColor = CYAN;
      hiLabel = color("running", hiColor);
    } else if (s.hiStatus === "error") {
      hiColor = RED;
      hiLabel = color("error", hiColor);
    } else {
      hiColor = WHITE;
      hiLabel = dim(s.hiStatus);
    }
    const hiRemote = s.hiRemoteBlock > 0 ? ` / ${formatBlock(s.hiRemoteBlock)}` : "";
    const hiAge = s.hiLastSeen > 0 ? Date.now() - s.hiLastSeen : 0;
    const hiAgeStr = hiAge > 0 ? dim(` ${formatDuration(hiAge)}`) : "";

    const scanSpeed = s.lastCycleTimeMs > 0 ? Math.floor((s.cycleCount * 1000) / s.lastCycleTimeMs) : 0;
    const passesPerSec = s.lastCycleTimeMs > 0 ? (1000 / s.lastCycleTimeMs).toFixed(2) : "0.00";

    const lines = [
      bold("⚡ System & Infra"),
      `  Gas Price:    ${color(gwei, YELLOW)}`,
      `  Indexer:      ${hiLabel}${hiRemote}${hiAgeStr}`,
      `  Cycle Time:   ${color(s.lastCycleTimeMs > 0 ? `${s.lastCycleTimeMs}ms` : "—", WHITE)}`,
      `  Scan Speed:   ${color(String(scanSpeed), WHITE)} routes/s`,
      `  Throughput:   ${color(passesPerSec, WHITE)} passes/s`,
      ``,
      bold("📊 Executions"),
      `  Attempted:    ${color(String(state.metrics.executed), WHITE)}`,
      `  Successful:   ${color(String(state.metrics.successful), GREEN)}`,
      `  Failed:       ${color(String(state.metrics.failed), state.metrics.failed > 0 ? RED : WHITE)}`,
    ];
    return this.panelBox(lines, layout.sidebar);
  }

  private renderFooterLog(layout: TuiLayout, state: TuiState): RenderedPanel {
    const visibleCount = Math.max(0, layout.footerLog.height - 1);
    const startIdx = Math.max(0, state.log.length - visibleCount);
    const visible = state.log.slice(startIdx, startIdx + visibleCount);

    const lines: string[] = [bold("📋 Event Log (Filtered)")];
    for (const entry of visible) {
      const time = entry.time.toLocaleTimeString("en-US", { hour12: false });
      let component = color(entry.component.padEnd(10).slice(0, 10), CYAN);
      if (entry.component === "ERROR" || entry.component === "Failed") {
        component = color(entry.component.padEnd(10).slice(0, 10), RED);
      }
      lines.push(`  ${dim(time)}  ${component} ${entry.message}`);
    }
    while (lines.length < layout.footerLog.height) {
      lines.push("");
    }
    return this.panelBox(lines, layout.footerLog);
  }

  private renderKeymap(layout: TuiLayout, _state: TuiState): RenderedPanel {
    const hints = dim("Ctrl+Q quit  |  P pause  |  R reset stats");
    return {
      y: layout.keymap.y,
      content: cursor(layout.keymap.y, layout.keymap.x) + padRight(hints, layout.keymap.width),
    };
  }

  private panelBox(lines: string[], rect: PanelRect): RenderedPanel {
    let content = "";
    for (let i = 0; i < rect.height; i++) {
      const line = lines[i] ?? "";
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

function formatGwei(wei: bigint): string {
  const gwei = Number(wei) / 1e9;
  return `${gwei.toFixed(1)} gwei`;
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

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 5) return "";
  if (totalSec < 60) return `${totalSec}s ago`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m${s}s ago`;
}
