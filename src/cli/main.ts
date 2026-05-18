import { loadConfig } from "../config/loader.ts";
import { bootApplication } from "../orchestrator/boot.ts";
import { runPassLoop } from "../orchestrator/pass_loop.ts";
import { shutdownApplication } from "../orchestrator/shutdown.ts";
import { startTui, type BotState } from "./tui.ts";

function createBotState(): BotState {
  return {
    status: "running",
    mode: "live",
    passCount: 0,
    consecutiveErrors: 0,
    gasPrice: "0",
    lastArbMs: 0,
    totalTxAttempted: 0,
    totalTxSuccessful: 0,
    totalTxReverted: 0,
    opportunities: [],
    logs: [],
  };
}

async function main() {
  const tuiEnabled = process.argv.includes("--tui");
  const config = loadConfig(tuiEnabled ? { ...process.env, TUI: "true" } : process.env);

  const logBuffer: string[] = [];
  const ctx = await bootApplication(config, config.observability.tuiEnabled ? logBuffer : undefined);

  const botState = createBotState();
  botState.logs = logBuffer;

  let tuiCleanup: (() => void) | null = null;
  if (config.observability.tuiEnabled) {
    tuiCleanup = startTui(botState);
  }

  async function shutdown() {
    ctx.logger.warn({}, "Shutting down");
    tuiCleanup?.();
    await shutdownApplication(ctx);
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await runPassLoop(ctx, tuiEnabled ? (update: Partial<BotState>) => Object.assign(botState, update) : undefined);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
