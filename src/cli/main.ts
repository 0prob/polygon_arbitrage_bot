import { loadConfig } from "../config/loader.ts";
import { bootApplication } from "../orchestrator/boot.ts";
import { runPassLoop } from "../orchestrator/pass_loop.ts";
import { shutdownApplication } from "../orchestrator/shutdown.ts";
import { startTui, updateState, type BotState } from "./tui.ts";
import { createActivityLog } from "./activity.ts";
import { createHyperIndexProcess } from "../infra/hypersync/hyperindex_process.ts";
import { createRootLogger } from "../infra/observability/logger.ts";

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
  const botState = createBotState();
  botState.logs = logBuffer;

  const onUpdate = tuiEnabled ? (update: Partial<BotState>) => { Object.assign(botState, update); updateState(botState); } : undefined;
  const activity = createActivityLog(onUpdate, tuiEnabled);

  // Start HyperIndex ingestion process first
  const hyperIndex = createHyperIndexProcess({
    dataDir: config.paths.dataDir,
    polygonRpcUrl: config.rpc.polygonRpcUrls[0],
    envioApiToken: config.envioApiToken,
    logger: createRootLogger({ level: config.observability.logLevel }),
  });

  try {
    await hyperIndex.start();
  } catch (err) {
    console.error("Failed to start HyperIndex, continuing without it:", err);
  }
  const startedHyperIndex = hyperIndex.isRunning();

  const ctx = await bootApplication(config, activity, tuiEnabled ? logBuffer : undefined);

  const tuiCleanup = tuiEnabled ? startTui(botState) : null;

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    ctx.logger.warn({}, "Shutting down");
    activity("SHUTDOWN", "Shutting down");
    tuiCleanup?.();
    await shutdownApplication(ctx);
    if (startedHyperIndex) {
      await hyperIndex.stop();
    }
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await runPassLoop(ctx, onUpdate, activity);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
