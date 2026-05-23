import { loadConfig } from "../config/loader.ts";
import { bootApplication } from "../orchestrator/boot.ts";
import { runPassLoop } from "../orchestrator/pass_loop.ts";
import { shutdownApplication } from "../orchestrator/shutdown.ts";
import { createHyperIndexProcess } from "../infra/hypersync/hyperindex_process.ts";
import { createRootLogger } from "../infra/observability/logger.ts";
import { EventBus } from "../tui/events.ts";
import { createTui } from "../tui/main.ts";

async function main() {
  const useTui = process.argv.includes("--tui");
  const config = loadConfig(process.env);

  const bus = new EventBus();

  const hyperIndex = createHyperIndexProcess({
    dataDir: config.paths.dataDir,
    polygonRpcUrl: config.rpc.polygonRpcUrls[0],
    katanaRpcUrl: config.crossChainArb?.katanaRpcUrl,
    envioApiToken: config.envioApiToken,
    logger: createRootLogger({ level: config.observability.logLevel }),
    eventBus: useTui ? bus : undefined,
  });

  try {
    await hyperIndex.start();
  } catch (err) {
    console.error("Failed to start HyperIndex, continuing without it:", err);
  }
  const startedHyperIndex = hyperIndex.isRunning();

  const ctx = await bootApplication(config);

  const tui = useTui ? createTui(bus) : null;
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

  await runPassLoop(ctx, undefined, tui?.bus);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
