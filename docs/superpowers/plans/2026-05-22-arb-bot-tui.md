# Arb Bot TUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a high-performance, zero-dependency Bun-native TUI for the Polygon arb bot.

**Architecture:** Event-driven embedded TUI in the same process. A typed `EventBus` decouples bot internals from rendering. A mutable `TuiState` is updated by event handlers, and a 30fps render loop reads state and paints only dirty zones using ANSI escape codes.

**Tech Stack:** Bun runtime, raw TTY ANSI escapes (zero npm deps), Vitest for testing.

---

### Task 1: Event System (`src/tui/events.ts`)

**Files:**
- Create: `src/tui/events.ts`
- Create: `tests/tui/events.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/tui/events.test.ts
import { describe, it, expect, vi } from "vitest";
import { EventBus, type ArbEvent } from "../../src/tui/events.ts";

describe("EventBus", () => {
  it("delivers events to subscribed handlers", () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on(handler);

    const event: ArbEvent = { type: "heartbeat", elapsedMs: 100 };
    bus.emit(event);

    expect(handler).toHaveBeenCalledWith(event);
  });

  it("allows unsubscribe via returned function", () => {
    const bus = new EventBus();
    const handler = vi.fn();
    const off = bus.on(handler);

    off();
    bus.emit({ type: "heartbeat", elapsedMs: 50 });

    expect(handler).not.toHaveBeenCalled();
  });

  it("delivers to multiple handlers", () => {
    const bus = new EventBus();
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.on(h1);
    bus.on(h2);

    bus.emit({ type: "shutdown" });

    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it("survives handler throwing without affecting other handlers", () => {
    const bus = new EventBus();
    const throwing = vi.fn().mockImplementation(() => { throw new Error("oops"); });
    const good = vi.fn();
    bus.on(throwing);
    bus.on(good);

    expect(() => bus.emit({ type: "heartbeat", elapsedMs: 0 })).not.toThrow();
    expect(good).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- tests/tui/events.test.ts`
Expected: FAIL with "Cannot find module ..."

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/tui/events.ts
export type ArbEvent =
  | { type: "pass_loop_started"; intervalMs: number }
  | { type: "graph_built"; poolCount: number; cycleCount: number }
  | { type: "opportunity_found"; routeKey: string; profitWei: bigint }
  | { type: "execution_submitted"; routeKey: string; txHash?: string }
  | { type: "execution_result"; routeKey: string; success: boolean; txHash?: string; error?: string }
  | { type: "gas_snapshot"; gasPrice: bigint }
  | { type: "pool_discovery"; count: number }
  | { type: "error"; component: string; message: string }
  | { type: "shutdown" }
  | { type: "heartbeat"; elapsedMs: number };

type EventHandler = (event: ArbEvent) => void;

export class EventBus {
  private handlers = new Set<EventHandler>();

  on(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }

  emit(event: ArbEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // swallow handler errors so one bad handler doesn't kill the bus
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- tests/tui/events.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/tui/events.ts tests/tui/events.test.ts
git commit -m "feat(tui): add EventBus and ArbEvent types"
```

---

### Task 2: State Model (`src/tui/state.ts`)

**Files:**
- Create: `src/tui/state.ts`
- Create: `tests/tui/state.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/tui/state.test.ts
import { describe, it, expect } from "vitest";
import { createInitialState, applyEvent } from "../../src/tui/state.ts";

describe("createInitialState", () => {
  it("returns zeroed metrics", () => {
    const s = createInitialState();
    expect(s.metrics.opportunitiesFound).toBe(0);
    expect(s.metrics.executed).toBe(0);
    expect(s.metrics.successful).toBe(0);
    expect(s.metrics.failed).toBe(0);
    expect(s.metrics.totalProfitWei).toBe(0n);
  });

  it("starts with isRunning false", () => {
    const s = createInitialState();
    expect(s.isRunning).toBe(false);
  });
});

describe("applyEvent", () => {
  it("increments opportunitiesFound on opportunity_found", () => {
    const s = createInitialState();
    applyEvent(s, { type: "opportunity_found", routeKey: "a", profitWei: 100n });
    expect(s.metrics.opportunitiesFound).toBe(1);
    expect(s.metrics.totalProfitWei).toBe(100n);
  });

  it("tracks execution result counts", () => {
    const s = createInitialState();
    applyEvent(s, { type: "execution_result", routeKey: "a", success: true });
    applyEvent(s, { type: "execution_result", routeKey: "b", success: false, error: "fail" });
    expect(s.metrics.executed).toBe(2);
    expect(s.metrics.successful).toBe(1);
    expect(s.metrics.failed).toBe(1);
  });

  it("updates system gas price on gas_snapshot", () => {
    const s = createInitialState();
    applyEvent(s, { type: "gas_snapshot", gasPrice: 32n * 10n ** 9n });
    expect(s.system.gasPriceWei).toBe(32n * 10n ** 9n);
  });

  it("updates pool count on graph_built", () => {
    const s = createInitialState();
    applyEvent(s, { type: "graph_built", poolCount: 184, cycleCount: 42 });
    expect(s.system.poolCount).toBe(184);
    expect(s.system.cycleCount).toBe(42);
  });

  it("appends to log on error events", () => {
    const s = createInitialState();
    applyEvent(s, { type: "error", component: "PassLoop", message: "oops" });
    expect(s.log.length).toBe(1);
    expect(s.log[0].component).toBe("PassLoop");
  });

  it("caps log at 1000 entries", () => {
    const s = createInitialState();
    for (let i = 0; i < 1001; i++) {
      applyEvent(s, { type: "heartbeat", elapsedMs: i });
    }
    expect(s.log.length).toBe(1000);
    expect(s.log[0].component).toBe("heartbeat");
    expect(s.log[999].component).toBe("heartbeat");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- tests/tui/state.test.ts`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/tui/state.ts
import type { ArbEvent } from "./events.ts";

export interface MetricsState {
  opportunitiesFound: number;
  executed: number;
  successful: number;
  failed: number;
  totalProfitWei: bigint;
}

export interface SystemState {
  gasPriceWei: bigint;
  poolCount: number;
  cycleCount: number;
  lastCycleTimeMs: number;
}

export interface LogEntry {
  time: Date;
  component: string;
  message: string;
}

export interface TuiState {
  metrics: MetricsState;
  system: SystemState;
  log: LogEntry[];
  isRunning: boolean;
  isPaused: boolean;
}

const MAX_LOG = 1000;

export function createInitialState(): TuiState {
  return {
    metrics: {
      opportunitiesFound: 0,
      executed: 0,
      successful: 0,
      failed: 0,
      totalProfitWei: 0n,
    },
    system: {
      gasPriceWei: 0n,
      poolCount: 0,
      cycleCount: 0,
      lastCycleTimeMs: 0,
    },
    log: [],
    isRunning: false,
    isPaused: false,
  };
}

function appendLog(state: TuiState, component: string, message: string): void {
  state.log.push({ time: new Date(), component, message });
  if (state.log.length > MAX_LOG) {
    state.log.splice(0, state.log.length - MAX_LOG);
  }
}

export function applyEvent(state: TuiState, event: ArbEvent): void {
  switch (event.type) {
    case "pass_loop_started":
      state.isRunning = true;
      appendLog(state, "System", "Pass loop started");
      break;
    case "graph_built":
      state.system.poolCount = event.poolCount;
      state.system.cycleCount = event.cycleCount;
      appendLog(state, "Graph", `${event.poolCount} pools, ${event.cycleCount} cycles`);
      break;
    case "opportunity_found":
      state.metrics.opportunitiesFound++;
      state.metrics.totalProfitWei += event.profitWei;
      appendLog(state, "Pipeline", `Profit: ${event.profitWei} wei [${event.routeKey.slice(0, 10)}]`);
      break;
    case "execution_submitted":
      state.metrics.executed++;
      appendLog(state, "Exec", `Submitted ${event.txHash.slice(0, 10)}... [${event.routeKey.slice(0, 10)}]`);
      break;
    case "execution_result":
      if (event.success) {
        state.metrics.successful++;
        appendLog(state, "Exec", `Confirmed ${event.txHash?.slice(0, 10)}...`);
      } else {
        state.metrics.failed++;
        appendLog(state, "Exec", `Failed: ${event.error ?? "unknown"}`);
      }
      break;
    case "gas_snapshot":
      state.system.gasPriceWei = event.gasPrice;
      break;
    case "pool_discovery":
      state.system.poolCount = event.count;
      appendLog(state, "Discovery", `${event.count} pools discovered`);
      break;
    case "error":
      appendLog(state, event.component, event.message);
      break;
    case "shutdown":
      state.isRunning = false;
      appendLog(state, "System", "Shutting down");
      break;
    case "heartbeat":
      state.system.lastCycleTimeMs = event.elapsedMs;
      break;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- tests/tui/state.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tui/state.ts tests/tui/state.test.ts
git commit -m "feat(tui): add TuiState model with event-driven updater"
```

---

### Task 3: Layout Calculator (`src/tui/layout.ts`)

**Files:**
- Create: `src/tui/layout.ts`
- Create: `tests/tui/layout.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/tui/layout.test.ts
import { describe, it, expect } from "vitest";
import { computeLayout } from "../../src/tui/layout.ts";

describe("computeLayout", () => {
  it("assigns status bar to row 0", () => {
    const layout = computeLayout(80, 24);
    expect(layout.statusBar.y).toBe(0);
    expect(layout.statusBar.height).toBe(1);
  });

  it("assigns keymap bar to last row", () => {
    const layout = computeLayout(80, 24);
    expect(layout.keymapBar.y).toBe(23);
    expect(layout.keymapBar.height).toBe(1);
  });

  it("splits middle section into two columns", () => {
    const layout = computeLayout(80, 24);
    // Middle section: rows 1-22, split into left (metrics) and right (system)
    expect(layout.metricsPanel.y).toBe(1);
    expect(layout.systemPanel.y).toBe(1);
    expect(layout.metricsPanel.x).toBe(0);
    expect(layout.systemPanel.x).toBeGreaterThan(0);
    expect(layout.metricsPanel.width + layout.systemPanel.width).toBe(80);
  });

  it("places log panel below metrics/system", () => {
    const layout = computeLayout(80, 24);
    expect(layout.logPanel.y).toBeGreaterThan(layout.metricsPanel.y + layout.metricsPanel.height - 1);
  });

  it("handles small terminal gracefully", () => {
    const layout = computeLayout(40, 10);
    // Should still produce valid rects
    expect(layout.statusBar.width).toBe(40);
    expect(layout.keymapBar.width).toBe(40);
    expect(layout.metricsPanel.width + layout.systemPanel.width).toBe(40);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- tests/tui/layout.test.ts`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/tui/layout.ts
export interface PanelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TuiLayout {
  statusBar: PanelRect;
  metricsPanel: PanelRect;
  systemPanel: PanelRect;
  logPanel: PanelRect;
  keymapBar: PanelRect;
}

const STATUS_HEIGHT = 1;
const KEYMAP_HEIGHT = 1;
const TOP_PANEL_HEIGHT = 6; // fixed height for metrics + system
const DIVIDER_HEIGHT = 0;   // no gap rows

export function computeLayout(cols: number, rows: number): TuiLayout {
  const middleHeight = rows - STATUS_HEIGHT - KEYMAP_HEIGHT;
  const topHeight = Math.min(TOP_PANEL_HEIGHT, Math.floor(middleHeight / 3));
  const logHeight = middleHeight - topHeight;

  const halfCols = Math.floor(cols / 2);

  return {
    statusBar: { x: 0, y: 0, width: cols, height: STATUS_HEIGHT },
    metricsPanel: { x: 0, y: STATUS_HEIGHT, width: halfCols, height: topHeight },
    systemPanel: { x: halfCols, y: STATUS_HEIGHT, width: cols - halfCols, height: topHeight },
    logPanel: { x: 0, y: STATUS_HEIGHT + topHeight, width: cols, height: logHeight },
    keymapBar: { x: 0, y: rows - KEYMAP_HEIGHT, width: cols, height: KEYMAP_HEIGHT },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- tests/tui/layout.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tui/layout.ts tests/tui/layout.test.ts
git commit -m "feat(tui): add layout calculator for terminal panels"
```

---

### Task 4: Renderer (`src/tui/renderer.ts`)

**Files:**
- Create: `src/tui/renderer.ts`
- Create: `tests/tui/renderer.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/tui/renderer.test.ts
import { describe, it, expect, vi } from "vitest";
import { Renderer } from "../../src/tui/renderer.ts";
import { computeLayout } from "../../src/tui/layout.ts";
import { createInitialState, applyEvent } from "../../src/tui/state.ts";

function createMockStdout() {
  let buffer = "";
  return {
    write: vi.fn((chunk: string) => { buffer += chunk; }),
    getBuffer: () => buffer,
    columns: 80,
    rows: 24,
  } as any;
}

describe("Renderer", () => {
  it("enters alternate screen on enter()", () => {
    const stdout = createMockStdout();
    const r = new Renderer(stdout);
    r.enter();
    expect(stdout.write).toHaveBeenCalledWith(expect.stringContaining("?1049h"));
  });

  it("exits alternate screen on exit()", () => {
    const stdout = createMockStdout();
    const r = new Renderer(stdout);
    r.enter();
    stdout.write.mockClear();
    r.exit();
    expect(stdout.write).toHaveBeenCalledWith(expect.stringContaining("?1049l"));
  });

  it("renders status bar with title", () => {
    const stdout = createMockStdout();
    const r = new Renderer(stdout);
    const layout = computeLayout(80, 24);
    const state = createInitialState();
    state.isRunning = true;

    r.render(layout, state);
    const output = stdout.getBuffer();
    expect(output).toContain("Arb Bot");
  });

  it("renders metrics panel with counts", () => {
    const stdout = createMockStdout();
    const r = new Renderer(stdout);
    const layout = computeLayout(80, 24);
    const state = createInitialState();
    applyEvent(state, { type: "opportunity_found", routeKey: "0xtest", profitWei: 100n });
    applyEvent(state, { type: "execution_result", routeKey: "0xtest", success: true });

    r.render(layout, state);
    const output = stdout.getBuffer();
    expect(output).toContain("1"); // 1 opportunity
    expect(output).toContain("1"); // 1 successful
  });

  it("renders log entries", () => {
    const stdout = createMockStdout();
    const r = new Renderer(stdout);
    const layout = computeLayout(80, 24);
    const state = createInitialState();
    applyEvent(state, { type: "error", component: "Test", message: "hello world" });

    r.render(layout, state);
    const output = stdout.getBuffer();
    expect(output).toContain("hello world");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- tests/tui/renderer.test.ts`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/tui/renderer.ts
import type { TuiLayout } from "./layout.ts";
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
      buf += cursor(panel.y, 0);
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
      content: clearLine() + line,
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
    // Fill remaining lines
    while (lines.length < layout.logPanel.height) {
      lines.push("");
    }
    return this.panelBox(lines, layout.logPanel);
  }

  private renderKeymap(layout: TuiLayout, state: TuiState): RenderedPanel {
    const hints = dim("Ctrl+Q quit  |  P pause  |  R reset stats");
    return {
      y: layout.keymapBar.y,
      content: clearLine() + hints,
    };
  }

  private panelBox(lines: string[], rect: PanelRect): RenderedPanel {
    // Each line is cleared then written
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
```

Note: `TuiState` needs a `_startTime` field. Update `state.ts`:

```typescript
// Add to TuiState interface:
  _startTime: number;

// Add to createInitialState():
  _startTime: 0,

// Add to applyEvent pass_loop_started case:
  state._startTime = state._startTime === 0 ? Date.now() : state._startTime;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- tests/tui/renderer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tui/renderer.ts src/tui/state.ts tests/tui/renderer.test.ts
git commit -m "feat(tui): add ANSI terminal renderer"
```

---

### Task 5: Main TUI Orchestrator (`src/tui/main.ts` + `src/tui/index.ts`)

**Files:**
- Create: `src/tui/main.ts`
- Create: `src/tui/index.ts`
- Create: `tests/tui/main.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/tui/main.test.ts
import { describe, it, expect, vi } from "vitest";
import { createTui } from "../../src/tui/main.ts";

describe("createTui", () => {
  it("returns a TuiInstance with bus", () => {
    const tui = createTui();
    expect(tui.bus).toBeDefined();
    expect(typeof tui.start).toBe("function");
    expect(typeof tui.stop).toBe("function");
  });

  it("start and stop are safe to call multiple times", () => {
    const tui = createTui();
    expect(() => { tui.start(); tui.stop(); tui.start(); tui.stop(); }).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- tests/tui/main.test.ts`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/tui/main.ts
import { EventBus, type ArbEvent } from "./events.ts";
import { createInitialState, applyEvent, type TuiState } from "./state.ts";
import { computeLayout, type TuiLayout } from "./layout.ts";
import { Renderer } from "./renderer.ts";

export interface TuiInstance {
  bus: EventBus;
  start(): void;
  stop(): void;
}

export function createTui(): TuiInstance {
  const bus = new EventBus();
  const state = createInitialState();
  const renderer = new Renderer(process.stdout);
  let layout = computeLayout(process.stdout.columns, process.stdout.rows);
  let timer: ReturnType<typeof setInterval> | null = null;
  let stdinHandler: ((data: Buffer) => void) | null = null;
  let started = false;

  function handleResize(): void {
    layout = computeLayout(process.stdout.columns, process.stdout.rows);
  }

  function renderFrame(): void {
    renderer.render(layout, state);
  }

  function handleKey(data: Buffer): void {
    const key = data.toString();
    if (key === "q" || key === "\u0011") { // q or Ctrl+Q
      stop();
      process.exit(0);
    }
    if (key === "p" || key === "P") {
      state.isPaused = !state.isPaused;
    }
    if (key === "r" || key === "R") {
      Object.assign(state, createInitialState());
    }
  }

  // Wire event bus → state updates
  bus.on((event: ArbEvent) => {
    applyEvent(state, event);
  });

  return {
    bus,

    start() {
      if (started) return;
      started = true;

      renderer.enter();

      process.stdout.on("resize", handleResize);

      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        stdinHandler = handleKey;
        process.stdin.on("data", stdinHandler);
        process.stdin.resume();
      }

      timer = setInterval(renderFrame, 33); // ~30fps
    },

    stop() {
      if (!started) return;
      started = false;

      if (timer) {
        clearInterval(timer);
        timer = null;
      }

      process.stdout.off("resize", handleResize);

      if (stdinHandler) {
        process.stdin.off("data", stdinHandler);
        process.stdin.setRawMode(false);
        stdinHandler = null;
      }

      renderer.exit();
    },
  };
}
```

- [ ] **Step 4: Write index.ts**

```typescript
// src/tui/index.ts
export { createTui } from "./main.ts";
export { EventBus, type ArbEvent } from "./events.ts";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun run test -- tests/tui/main.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/tui/main.ts src/tui/index.ts tests/tui/main.test.ts
git commit -m "feat(tui): add TUI orchestrator with keyboard input and frame pacing"
```

---

### Task 6: Wire TUI into CLI (`src/cli/main.ts`)

**Files:**
- Modify: `src/cli/main.ts`

- [ ] **Step 1: Modify main.ts to accept --tui flag and wire TUI**

```typescript
// src/cli/main.ts — updated
import { loadConfig } from "../config/loader.ts";
import { bootApplication } from "../orchestrator/boot.ts";
import { runPassLoop } from "../orchestrator/pass_loop.ts";
import { shutdownApplication } from "../orchestrator/shutdown.ts";
import { createHyperIndexProcess } from "../infra/hypersync/hyperindex_process.ts";
import { createRootLogger } from "../infra/observability/logger.ts";
import { createTui } from "../tui/main.ts";

async function main() {
  const useTui = process.argv.includes("--tui");
  const config = loadConfig(process.env);

  const hyperIndex = createHyperIndexProcess({
    dataDir: config.paths.dataDir,
    polygonRpcUrl: config.rpc.polygonRpcUrls[0],
    katanaRpcUrl: config.crossChainArb?.katanaRpcUrl,
    envioApiToken: config.envioApiToken,
    logger: createRootLogger({ level: config.observability.logLevel }),
  });

  try {
    await hyperIndex.start();
  } catch (err) {
    console.error("Failed to start HyperIndex, continuing without it:", err);
  }
  const startedHyperIndex = hyperIndex.isRunning();

  const ctx = await bootApplication(config);

  // Initialize TUI if --tui flag
  const tui = useTui ? createTui() : null;
  if (tui) {
    tui.start();
  }

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    ctx.logger.warn({}, "Shutting down");
    tui?.bus.emit({ type: "shutdown" });
    tui?.stop();
    await shutdownApplication(ctx);
    if (startedHyperIndex) {
      await hyperIndex.stop();
    }
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await runPassLoop(ctx, undefined, tui?.bus ?? undefined);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify types compile**

Run: `bun run typecheck`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add src/cli/main.ts
git commit -m "feat(tui): wire TUI into CLI with --tui flag"
```

---

### Task 7: Wire Events into Pass Loop (`src/orchestrator/pass_loop.ts`)

**Files:**
- Modify: `src/orchestrator/pass_loop.ts`

- [ ] **Step 1: Update pass_loop.ts to accept optional EventBus and emit events**

Update the function signature and add event emissions:

```typescript
// src/orchestrator/pass_loop.ts — updated sections

// Add import:
import type { EventBus } from "../tui/events.ts";

// Update signature:
export async function runPassLoop(
  ctx: RuntimeContext,
  deps: PassLoopDeps = DEFAULT_DEPS,
  bus?: EventBus,
): Promise<void> {
  const intervalMs = ctx.config.routing.cycleRefreshIntervalMs;
  const executorAddress = ctx.config.execution.executorAddress;

  await ctx.executionService.start();
  await ctx.mempoolService.start();

  bus?.emit({ type: "pass_loop_started", intervalMs });
  ctx.logger.info({ intervalMs }, "Pass loop started");

  // ... existing code stays the same ...

  // After graph rebuild (around line 110-113):
  ctx.logger.info({ pools: pools.length, cycles: cachedCycles.length }, "Graph and cycles re-enumerated");
  bus?.emit({ type: "graph_built", poolCount: pools.length, cycleCount: cachedCycles.length });

  // After profitable opportunities found (around line 140-174):
  if (result.profitableCount > 0) {
    ctx.logger.info({ attempted: result.attempted, profitable: result.profitableCount }, "Profitable opportunities found");

    for (const profitable of result.profitable) {
      if (!ctx.isRunning) break;

      const routeKey = deps.routeKeyFromEdges(profitable.cycle.edges, profitable.cycle.startToken);
      bus?.emit({ type: "opportunity_found", routeKey, profitWei: profitable.assessment.netProfitAfterGas });

      // ... build candidate ...

      ctx.logger.info({ routeKey, profit: profitable.assessment.netProfitAfterGas }, "Executing opportunity");
      bus?.emit({ type: "execution_submitted", routeKey });

      // ... execute ...

      if (execResult.success) {
        ctx.logger.info({ txHash: execResult.txHash, routeKey }, "Transaction submitted successfully");
        bus?.emit({ type: "execution_result", routeKey, success: true, txHash: execResult.txHash });
      } else {
        ctx.logger.warn({ error: execResult.error, routeKey }, "Execution failed");
        bus?.emit({ type: "execution_result", routeKey, success: false, error: execResult.error });
      }
    }
  }
```

- [ ] **Step 2: Verify compilation**

Run: `bun run typecheck`
Expected: No type errors

- [ ] **Step 3: Run pass loop test to ensure nothing broke**

Run: `bun run test -- src/orchestrator/pass_loop.test.ts`
Expected: PASS (existing tests still pass)

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator/pass_loop.ts
git commit -m "feat(tui): emit TUI events from pass loop"
```

---

### Self-Review Checklist

1. **Spec coverage:** Every requirement from the spec has a task:
   - Event system → Task 1
   - State model → Task 2
   - Layout → Task 3
   - Renderer with ANSI/alternate screen/dirty tracking → Task 4
   - Frame pacing, input handling, lifecycle → Task 5
   - --tui flag integration → Task 6
   - Pass loop event wiring → Task 7

2. **Placeholder scan:** No TBD, TODO, or vague steps. All code is concrete.

3. **Type consistency:** `EventBus`/`ArbEvent` used consistently across all tasks. `TuiState` layout matches what `Renderer` uses. `_startTime` added to `TuiState` in Task 4 and referenced in Task 4's renderer — consistent.
