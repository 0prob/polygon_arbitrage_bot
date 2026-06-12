#!/usr/bin/env bun
/**
 * Automated debug runner — starts the bot with inspector + BOT_DEBUG instrumentation.
 * Terminal:  bun run debug
 * Cursor:    Tasks → "bot: debug (automated)"  OR  F5 → "Bot: Automated debug"
 */
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

const workspace = join(import.meta.dir, "..");
const port = process.env.BOT_DEBUG_PORT ?? "9229";
const inspectPath = process.env.BOT_DEBUG_PATH ?? "run";
const inspectUrl = `ws://127.0.0.1:${port}/${inspectPath}`;
const browserUrl = `https://debug.bun.sh/#127.0.0.1:${port}/${inspectPath}`;

const useTui = process.argv.includes("--tui");
const useFull = process.argv.includes("--full");
const once = process.argv.includes("--once");
const entry = useFull ? "src/cli/main.ts" : "src/cli/arb_only_debug.ts";
const maxRestarts = Number(process.env.BOT_DEBUG_MAX_RESTARTS ?? "0");

let restarts = 0;
let child: ChildProcess | null = null;
let stopping = false;

async function inspectorReady(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    return res.status === 404;
  } catch {
    return false;
  }
}

async function waitForInspector(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await inspectorReady()) {
      console.error(`[debug-run] DEBUGGER_READY ${inspectUrl}`);
      return;
    }
    await Bun.sleep(100);
  }
  console.error(`[debug-run] WARN: inspector not ready after ${timeoutMs}ms`);
}

function launch(): ChildProcess {
  const runId = process.env.BOT_DEBUG_RUN_ID ?? `run-${Date.now()}`;
  const inspectFlag = `--inspect=127.0.0.1:${port}/${inspectPath}`;
  const args = [inspectFlag, "--env-file=.env", "run", entry];
  if (useTui) args.push("--tui");

  console.error(`[debug-run] starting ${entry} (runId=${runId}, restart=${restarts})`);
  console.error(`[debug-run] attach ${inspectUrl}`);
  console.error(`[debug-run] browser ${browserUrl}`);

  const proc = spawn("bun", args, {
    cwd: workspace,
    env: { ...process.env, BOT_DEBUG: "1", BOT_DEBUG_RUN_ID: runId },
    stdio: "inherit",
  });

  void waitForInspector();

  if (!once) {
    proc.on("exit", (code, signal) => {
      if (stopping) return;
      restarts++;
      console.error(`[debug-run] exited code=${code ?? "null"} signal=${signal ?? "null"} restart=${restarts}`);
      if (maxRestarts > 0 && restarts >= maxRestarts) {
        process.exit(code ?? 1);
      }
      const backoff = Math.min(5000, 500 * restarts);
      setTimeout(() => {
        if (!stopping) child = launch();
      }, backoff);
    });
  } else {
    proc.on("exit", (code) => {
      process.exit(code ?? 0);
    });
  }

  return proc;
}

function shutdown(): void {
  if (stopping) return;
  stopping = true;
  console.error("[debug-run] shutting down");
  child?.kill("SIGTERM");
  setTimeout(() => process.exit(0), 2000);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

if (await inspectorReady()) {
  console.error(`[debug-run] inspector already on ${inspectUrl}`);
  console.error(`[debug-run] DEBUGGER_READY ${inspectUrl}`);
  console.error('[debug-run] attach via F5 → "Bot: Attach (9229 TCP)"');
  await new Promise(() => {});
} else {
  child = launch();
}
