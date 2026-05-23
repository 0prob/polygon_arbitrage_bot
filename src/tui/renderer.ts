import type { TuiLayout, PanelRect } from "./layout.ts";
import type { TuiState } from "./state.ts";

const ESC = "\x1b";

function cursor(row: number, col: number): string {
  return `${ESC}[${row + 1};${col + 1}H`;
}

function clearLine(): string {
  return `${ESC}[2K`;
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
    buf += clearLine();
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

    panels.push(this.renderStatusBar(layout, state));
    panels.push(this.renderMetrics(layout, state));
    panels.push(this.renderSystem(layout, state));
    panels.push(this.renderLog(layout, state));
    panels.push(this.renderKeymap(layout, state));

    let buf = "";
    for (const panel of panels) {
      buf += panel.content;
    }
    this.stdout.write(buf);
  }

  private renderStatusBar(layout: TuiLayout, state: TuiState): RenderedPanel {
    const running = state.isRunning ? color("● running", GREEN) : color("● stopped", RED);
    const paused = state.isPaused ? color(" PAUSED", YELLOW) : "";
    const pools = `${state.system.poolCount} pools`;
    const title = `${bold("Arb Bot")}  ${running}${paused}  ${dim(pools)}`;
    const line = title.padEnd(layout.statusBar.width, "─");

    return {
      y: layout.statusBar.y,
      content: cursor(layout.statusBar.y, layout.statusBar.x) + clearLine() + line,
    };
  }

  private renderMetrics(layout: TuiLayout, state: TuiState): RenderedPanel {
    const m = state.metrics;
    const lines = [
      bold("📊 Metrics"),
      `  Opportunities:  ${color(String(m.opportunitiesFound), CYAN)}`,
      `  Executed:       ${color(String(m.executed), WHITE)}`,
      `  Successful:     ${color(String(m.successful), GREEN)}`,
      `  Failed:         ${color(String(m.failed), m.failed > 0 ? RED : WHITE)}`,
      `  Total Profit:   ${color(formatWei(m.totalProfitWei), CYAN)}`,
    ];
    return this.panelBox(lines, layout.metricsPanel);
  }

  private renderSystem(layout: TuiLayout, state: TuiState): RenderedPanel {
    const s = state.system;
    const gwei = s.gasPriceWei > 0n ? formatGwei(s.gasPriceWei) : "—";
    const lines = [
      bold("⚡ System"),
      `  Gas Price:    ${color(gwei, YELLOW)}`,
      `  Pools:        ${color(String(s.poolCount), CYAN)}`,
      `  Cycles:       ${color(String(s.cycleCount), WHITE)}`,
      `  Cycle Time:   ${color(s.lastCycleTimeMs > 0 ? `${s.lastCycleTimeMs}ms` : "—", WHITE)}`,
      `  Uptime:       ${dim(formatUptime(state._startTime > 0 ? Date.now() - state._startTime : 0))}`,
    ];
    return this.panelBox(lines, layout.systemPanel);
  }

  private renderLog(layout: TuiLayout, state: TuiState): RenderedPanel {
    const visibleCount = Math.max(0, layout.logPanel.height - 1);
    const startIdx = Math.max(0, state.log.length - visibleCount);
    const visible = state.log.slice(startIdx, startIdx + visibleCount);

    const lines: string[] = [bold("📋 Activity Log")];
    for (const entry of visible) {
      const time = entry.time.toLocaleTimeString("en-US", { hour12: false });
      const component = color(entry.component.padEnd(12).slice(0, 12), CYAN);
      lines.push(`  ${dim(time)}  ${component} ${entry.message}`);
    }
    while (lines.length < layout.logPanel.height) {
      lines.push("");
    }
    return this.panelBox(lines, layout.logPanel);
  }

  private renderKeymap(layout: TuiLayout, _state: TuiState): RenderedPanel {
    const hints = dim("Ctrl+Q quit  |  P pause  |  R reset stats");
    return {
      y: layout.keymapBar.y,
      content: cursor(layout.keymapBar.y, layout.keymapBar.x) + clearLine() + hints,
    };
  }

  private panelBox(lines: string[], rect: PanelRect): RenderedPanel {
    let content = "";
    for (let i = 0; i < lines.length && i < rect.height; i++) {
      if (i > 0) content += "\n";
      const line = lines[i] ?? "";
      content += cursor(rect.y + i, rect.x);
      content += clearLine();
      content += line.slice(0, rect.width);
    }
    return { y: rect.y, content };
  }
}

function formatWei(wei: bigint): string {
  const eth = Number(wei) / 1e18;
  return eth < 0.001 ? eth.toFixed(6) : eth.toFixed(4);
}

function formatGwei(wei: bigint): string {
  const gwei = Number(wei) / 1e9;
  return `${gwei.toFixed(1)} gwei`;
}

function formatUptime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}
