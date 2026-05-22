# Arb Bot TUI Design

## Overview

A Bun-native terminal UI for the Polygon arb bot that displays real-time metrics, system status, and an activity log. Fully decoupled from bot internals via a typed event system. Zero npm dependencies.

## Architecture

```
src/tui/
  events.ts     — ArbEvent union + EventBus class
  state.ts      — Mutable state model (metrics, log ring buffer, system info)
  layout.ts     — Panel positions computed from terminal dimensions
  renderer.ts   — Raw ANSI rendering (alternate screen, cursor positioning, styled output)
  main.ts       — Wires event bus → state → renderer, handles keyboard input, lifecycle
```

The bot imports only `events.ts` to emit events. The TUI module is instantiated in `main.ts` when `--tui` is passed.

### Event System (`events.ts`)

Typed discriminated union:

```typescript
type ArbEvent =
  | { type: "pass_loop_started"; intervalMs: number }
  | { type: "graph_built"; poolCount: number; cycleCount: number }
  | { type: "opportunity_found"; routeKey: string; profitWei: bigint }
  | { type: "execution_submitted"; routeKey: string; txHash: string }
  | { type: "execution_result"; routeKey: string; success: boolean; txHash?: string; error?: string }
  | { type: "gas_snapshot"; gasPrice: bigint }
  | { type: "pool_discovery"; count: number }
  | { type: "error"; component: string; message: string }
  | { type: "shutdown" }
  | { type: "heartbeat"; elapsedMs: number };
```

`EventBus` is a simple typed emitter — `emit(event)` calls all registered `on("arb_event", cb)` callbacks synchronously (zero-copy).

### State Model (`state.ts`)

A single mutable `TuiState` object updated in-place by event handlers:

- `metrics`: opportunity count, executed count, success count, fail count, total profit (bigint)
- `system`: gas price, pools, cycle time, uptime, memory usage
- `log`: ring buffer of `LogEntry[]` (max 1000), viewport offset for scrolling
- `status`: running/paused/stopped

### Layout (`layout.ts`)

3-row layout computed from `process.stdout.columns` / `rows`:

| Row   | Panel       | Height  | Content                                  |
|-------|-------------|---------|------------------------------------------|
| 0     | Status bar  | 1       | Title, runtime status, uptime, pool count |
| 1     | Metrics     | ~33% h  | Left pane: opportunity/execution stats    |
| 1     | System      | ~33% h  | Right pane: gas price, cycle time, pools  |
| 2     | Activity log| ~66% h  | Scrollable log entries with timestamps    |
| last  | Keymap bar  | 1       | Keyboard shortcut hints                   |

Rendered zones are tracked as dirty rectangles. Only changed zones are redrawn per frame.

### Renderer (`renderer.ts`)

- **Startup**: save cursor, enter alternate screen, hide cursor, set raw mode
- **Each frame**: for each dirty zone, position cursor absolutely and write ANSI-styled content
- **Write batching**: all writes per frame buffered into a single `process.stdout.write()` call
- **Colors**: standard ANSI 16-color palette (Bun native, no 24-bit needed):
  - Green for success/active
  - Yellow for warnings/pending
  - Red for errors
  - Cyan for informational
  - Dim for less important text
- **Shutdown**: show cursor, leave alternate screen, restore terminal, close stdin raw mode

### Input Handling

- `stdin.setRawMode(true)`, listen on `data` events
- Key bindings: `Ctrl+Q` / `q` quit, `p` pause/resume, `r` reset stats, `↑`/`↓` scroll log
- Input read asynchronously, never blocks render cycle

### Frame Pacing

- `setInterval` at 33ms (~30fps)
- Each frame: iterate dirty zones, write buffered output, clear dirty flags
- If no dirty zones, skip write entirely (zero syscalls on idle frames)

## Integration with Bot

In `main.ts`:

```typescript
if (argv.includes("--tui")) {
  const tui = createTui();
  tui.start();
  // tui.on("pause") → toggle ctx.isRunning
  // ctx emits events through tui.bus
}
```

The pass loop (`pass_loop.ts`) is refactored to accept an optional `EventBus` and emit events at key points:

- After graph build → emit `graph_built`
- On profitable pipeline result → emit `opportunity_found`
- After execution → emit `execution_submitted` / `execution_result`
- On gas snapshot → emit `gas_snapshot`
- On pool discovery → emit `pool_discovery`
- On errors → emit `error`

Events are fire-and-forget. The bot never waits for the TUI.

## Error Handling

- If TUI throws during render, catch and fall back to `console.log` output
- If `--tui` is passed but terminal doesn't support raw mode, fall back gracefully
- TUI errors never crash the bot pass loop

## Testing

- Unit tests for state updates from events (`state.test.ts`)
- Unit tests for layout calculations (`layout.test.ts`)
- Integration test rendering to a string buffer (mock stdout)
