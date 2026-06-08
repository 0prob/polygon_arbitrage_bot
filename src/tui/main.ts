/* eslint-disable no-console, @typescript-eslint/no-explicit-any */
import { EventBus, type ArbEvent } from "./events.ts";
import { createInitialState, applyEvent } from "./state.ts";
import { computeLayout } from "./layout.ts";
import { Renderer } from "./renderer.ts";
import type { Logger } from "../infra/observability/logger.ts";
import util from "util";

export interface TuiInstance {
  bus: EventBus;
  start(): void;
  stop(): void;
}

/** Panels available for tab/number focus. Increase this when panels are added. */
const PANEL_COUNT = 6;

/**
 * Render at 15fps (~67ms). The TUI only needs to reflect state that changes
 * on ~200ms HF cycles; 15fps provides smooth updates without event-loop pressure.
 * Avoid <50ms (20fps+) — at that rate the render itself becomes a measurable
 * fraction of the 200ms HF budget.
 */
const RENDER_INTERVAL_MS = 67;

export function createTui(bus?: EventBus, logger?: Logger): TuiInstance {
  if (!bus) bus = new EventBus();
  const state = createInitialState();
  const renderer = new Renderer(process.stdout);
  let layout = computeLayout(process.stdout.columns, process.stdout.rows);
  let timer: ReturnType<typeof setInterval> | null = null;
  let stdinHandler: ((data: Buffer) => void) | null = null;
  let frameCount = 0;
  let focusedSection = -1; // -1 = none, 0-(PANEL_COUNT-1) = section index
  let started = false;
  let originalConsole: {
    log: typeof console.log;
    info: typeof console.info;
    warn: typeof console.warn;
    error: typeof console.error;
    debug: typeof console.debug;
  } | null = null;

  function handleResize(): void {
    layout = computeLayout(process.stdout.columns, process.stdout.rows);
  }

  function renderFrame(): void {
    frameCount++;
    try {
      renderer.render(layout, state, frameCount, focusedSection);
    } catch {
      // Never let a render error propagate — it would kill the setInterval
    }
  }

  function stopImpl(): void {
    if (!started) return;
    started = false;

    if (timer) {
      clearInterval(timer);
      timer = null;
    }

    process.stdout.off("resize", handleResize);

    if (stdinHandler) {
      process.stdin.off("data", stdinHandler);
      try {
        process.stdin.setRawMode(false);
      } catch {
        // Not a TTY or already reset
      }
      stdinHandler = null;
    }

    if (originalConsole) {
      console.log = originalConsole.log;
      console.info = originalConsole.info;
      console.warn = originalConsole.warn;
      console.error = originalConsole.error;
      console.debug = originalConsole.debug;
      originalConsole = null;
    }

    renderer.exit();
  }

  function handleKey(data: Buffer): void {
    const key = data.toString();

    // Quit: q or Ctrl-Q
    if (key === "q" || key === "\u0011") {
      stopImpl();
      process.exit(0);
    }

    // Pause toggle
    if (key === "p" || key === "P") {
      state.isPaused = !state.isPaused;
      bus?.emit({ type: "pause_toggled", isPaused: state.isPaused });
    }

    // Reset state
    if (key === "r" || key === "R") {
      Object.assign(state, createInitialState());
      bus?.emit({ type: "pause_toggled", isPaused: false });
    }

    // Numeric section focus (1-PANEL_COUNT)
    if (key >= "1" && key <= String(PANEL_COUNT)) {
      focusedSection = parseInt(key) - 1;
    }

    // Tab cycles through sections; wraps back to -1 (unfocused)
    if (key === "\t") {
      if (focusedSection < 0) focusedSection = 0;
      else if (focusedSection >= PANEL_COUNT - 1) focusedSection = -1;
      else focusedSection++;
    }

    // Escape clears focus
    if (key === "\x1b" || key === "\u001b") {
      focusedSection = -1;
    }
  }

  bus.on((event: ArbEvent) => {
    applyEvent(state, event);
  });

  return {
    bus,

    start() {
      if (started) return;
      started = true;

      // Capture original console methods before hijacking
      originalConsole = {
        log: console.log,
        info: console.info,
        warn: console.warn,
        error: console.error,
        debug: console.debug,
      };

      /**
       * Redirect console output to the TUI event log + structured logger.
       *
       * IMPORTANT: All console levels are routed through the "error" event type
       * because that is the generic log-to-TUI channel. The *component* name
       * encodes the actual severity so the renderer can color-code it correctly.
       * This does NOT inflate the metrics.totalErrors counter — that is driven
       * solely by explicit ctx.metrics.totalErrors++ in the pass loop.
       */
      const makeRedirect = (level: "log" | "info" | "warn" | "error" | "debug") =>
        (...args: any[]) => {
          const formatted = util.format(...args);
          // Forward to file logger at the right severity
          if (logger) {
            if (level === "error") logger.error({ source: "console" }, formatted);
            else if (level === "warn") logger.warn({ source: "console" }, formatted);
            else if (level === "debug") logger.debug({ source: "console" }, formatted);
            else logger.info({ source: "console" }, formatted);
          }
          // Route into TUI log panel. Use the level as the component so the renderer
          // can apply a distinct color per severity.
          const component = level === "log" ? "Log" : level === "info" ? "Info" : level === "warn" ? "Warn" : level === "error" ? "Error" : "Debug";
          bus?.emit({ type: "error", component, message: formatted });
        };

      console.log = makeRedirect("log");
      console.info = makeRedirect("info");
      console.warn = makeRedirect("warn");
      console.error = makeRedirect("error");
      console.debug = makeRedirect("debug");

      renderer.enter();

      process.stdout.on("resize", handleResize);

      if (process.stdin.isTTY) {
        try {
          process.stdin.setRawMode(true);
        } catch {
          // Non-interactive stdin (piped input, CI, etc.) — skip raw mode
        }
        stdinHandler = handleKey;
        process.stdin.on("data", stdinHandler);
        process.stdin.resume();
      }

      // 15 fps render loop — non-blocking; render errors are caught inside renderFrame
      timer = setInterval(renderFrame, RENDER_INTERVAL_MS);

      // Ensure the timer does not prevent Node from exiting on natural shutdown
      if (timer.unref) timer.unref();
    },

    stop: stopImpl,
  };
}
