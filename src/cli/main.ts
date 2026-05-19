import { loadConfig } from "../config/loader.ts";
import { bootApplication } from "../orchestrator/boot.ts";
import { runPassLoop } from "../orchestrator/pass_loop.ts";
import { shutdownApplication } from "../orchestrator/shutdown.ts";
import { createHyperIndexProcess } from "../infra/hypersync/hyperindex_process.ts";
import { createRootLogger } from "../infra/observability/logger.ts";

async function main() {
  const config = loadConfig(process.env);

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

  const ctx = await bootApplication(config);

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    ctx.logger.warn({}, "Shutting down");
    await shutdownApplication(ctx);
    if (startedHyperIndex) {
      await hyperIndex.stop();
    }
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await runPassLoop(ctx);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
