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
  // Skip repaints when nothing changed since the last frame. Events mark the
  // state dirty; an idle TUI costs ~0 CPU instead of a full ANSI rebuild at 15fps.
  let dirty = true;
  let originalConsole: {
    log: typeof console.log;
    info: typeof console.info;
    warn: typeof console.warn;
    error: typeof console.error;
    debug: typeof console.debug;
  } | null = null;

  function handleResize(): void {
    layout = computeLayout(process.stdout.columns, process.stdout.rows);
    dirty = true;
  }

  function isAnimating(): boolean {
    const stage = state.system.pipelineStage;
    return (
      stage === "SIMULATING" ||
      stage === "ENUMERATING" ||
      stage === "EXECUTING" ||
      stage === "LF_REFRESH" ||
      stage === "DISCOVERY" ||
      stage === "PRE_FETCH" ||
      stage === "RATES" ||
      state.system.hiStatus === "syncing"
    );
  }

  let skippedFrames = 0;
  let renderedFrames = 0;

  function renderFrame(): void {
    const animating = isAnimating();
    if (!dirty && !animating) {
      skippedFrames++;
      // #region agent log
      if (skippedFrames % 30 === 1) {
        fetch("http://127.0.0.1:7263/ingest/ac6c9208-c536-42e7-b496-db8499c17483", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "fb4402" },
          body: JSON.stringify({
            sessionId: "fb4402",
            location: "main.ts:renderFrame",
            message: "frame skipped",
            data: { skippedFrames, renderedFrames, dirty, animating, stage: state.system.pipelineStage, hiStatus: state.system.hiStatus },
            timestamp: Date.now(),
            hypothesisId: "A",
            runId: "post-fix",
          }),
        }).catch(() => {});
      }
      // #endregion
      return;
    }
    dirty = false;
    frameCount++;
    renderedFrames++;
    // #region agent log
    if (renderedFrames % 15 === 1) {
      fetch("http://127.0.0.1:7263/ingest/ac6c9208-c536-42e7-b496-db8499c17483", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "fb4402" },
        body: JSON.stringify({
          sessionId: "fb4402",
          location: "main.ts:renderFrame",
          message: "frame rendered",
          data: { skippedFrames, renderedFrames, frameCount, animating, stage: state.system.pipelineStage, hiStatus: state.system.hiStatus },
          timestamp: Date.now(),
          hypothesisId: "A",
          runId: "post-fix",
        }),
      }).catch(() => {});
    }
    // #endregion
    try {
      renderer.render(layout, state, frameCount, focusedSection);
    } catch (err) {
      // #region agent log
      fetch("http://127.0.0.1:7263/ingest/ac6c9208-c536-42e7-b496-db8499c17483", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "fb4402" },
        body: JSON.stringify({
          sessionId: "fb4402",
          location: "main.ts:renderFrame:catch",
          message: "render error",
          data: { err: String(err) },
          timestamp: Date.now(),
          hypothesisId: "E",
        }),
      }).catch(() => {});
      // #endregion
      logger?.warn?.({ err }, "TUI render frame failed");
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
      } catch (err) {
        logger?.debug?.({ err }, "Failed to reset stdin raw mode (not a TTY)");
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
    dirty = true;

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
    dirty = true;
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
      const makeRedirect =
        (level: "log" | "info" | "warn" | "error" | "debug") =>
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
          const component =
            level === "log" ? "Log" : level === "info" ? "Info" : level === "warn" ? "Warn" : level === "error" ? "Error" : "Debug";
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
        } catch (err) {
          logger?.debug?.({ err }, "Failed to enable stdin raw mode (non-interactive stdin)");
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
