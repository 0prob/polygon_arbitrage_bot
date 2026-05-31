import { EventBus, type ArbEvent } from "./events.ts";
import { createInitialState, applyEvent } from "./state.ts";
import { computeLayout } from "./layout.ts";
import { Renderer } from "./renderer.ts";

export interface TuiInstance {
  bus: EventBus;
  start(): void;
  stop(): void;
}

export function createTui(bus?: EventBus): TuiInstance {
  if (!bus) bus = new EventBus();
  const state = createInitialState();
  const renderer = new Renderer(process.stdout);
  let layout = computeLayout(process.stdout.columns, process.stdout.rows);
  let timer: ReturnType<typeof setInterval> | null = null;
  let stdinHandler: ((data: Buffer) => void) | null = null;
  let frameCount = 0;
  let focusedSection = -1; // -1 = none, 0-5 = section index
  let started = false;

  function handleResize(): void {
    layout = computeLayout(process.stdout.columns, process.stdout.rows);
  }

  function renderFrame(): void {
    frameCount++;
    renderer.render(layout, state, frameCount, focusedSection);
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
      process.stdin.setRawMode(false);
      stdinHandler = null;
    }

    renderer.exit();
  }

  function handleKey(data: Buffer): void {
    const key = data.toString();
    if (key === "q" || key === "\u0011") {
      stopImpl();
      process.exit(0);
    }
    if (key === "p" || key === "P") {
      state.isPaused = !state.isPaused;
    }
    if (key === "r" || key === "R") {
      Object.assign(state, createInitialState());
    }
    if (key >= "1" && key <= "6") {
      focusedSection = parseInt(key) - 1;
    }
    if (key === "\t") {
      if (focusedSection < 0) focusedSection = 0;
      else if (focusedSection >= 5) focusedSection = -1;
      else focusedSection++;
    }
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

      renderer.enter();

      process.stdout.on("resize", handleResize);

      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        stdinHandler = handleKey;
        process.stdin.on("data", stdinHandler);
        process.stdin.resume();
      }

      timer = setInterval(renderFrame, 33);
    },

    stop: stopImpl,
  };
}
