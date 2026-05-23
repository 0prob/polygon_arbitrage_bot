import { EventBus, type ArbEvent } from "./events.ts";
import { createInitialState, applyEvent } from "./state.ts";
import { computeLayout } from "./layout.ts";
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
    if (key === "q" || key === "\u0011") {
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

  bus.on((event: ArbEvent) => {
    applyEvent(state, event);
  });

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
