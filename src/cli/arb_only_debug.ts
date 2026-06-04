import { loadConfig } from "../config/loader.ts";
import { bootApplication } from "../orchestrator/boot.ts";
import { PassRunner } from "../orchestrator/runner.ts";
import { shutdownApplication } from "../orchestrator/shutdown.ts";
import { createRootLogger } from "../infra/observability/logger.ts";
import { EventBus } from "../tui/events.ts";
import { createTui } from "../tui/main.ts";
import { mkdir } from "fs/promises";
import { join } from "path";

async function main() {
  const useTui = process.argv.includes("--tui");
  const config = loadConfig(process.env);

  const bus = new EventBus();

  let logger;
  if (useTui) {
    await mkdir(config.paths.dataDir, { recursive: true });
    logger = createRootLogger({
      level: config.observability.logLevel,
      fileMode: true,
      filePath: join(config.paths.dataDir, "runner.log"),
    });
  } else {
    logger = createRootLogger({ level: config.observability.logLevel });
  }

  logger.info({ hasuraUrl: config.hasuraUrl }, "Starting arb-only mode — assuming HyperIndex/Hasura is running externally");

  const ctx = await bootApplication(config, undefined, logger, undefined);

  // Health server requires a HyperIndexMonitor — skip in arb-only mode.

  const tui = useTui ? createTui(bus) : null;
  if (tui) {
    tui.start();
  }

  // Emit a basic hyperindex_status so the TUI doesn't sit empty
  const statusTimer = setInterval(() => {
    bus.emit({
      type: "hyperindex_status",
      status: "external",
      syncedBlock: 0,
      remoteBlock: 0,
      lag: 0,
      syncRate: 0,
      discoveryMode: "broad",
    });
  }, 10000);

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(statusTimer);
    ctx.logger.warn({}, "Shutting down");
    tui?.bus.emit({ type: "shutdown" });
    tui?.stop();
    await shutdownApplication(ctx);
    process.exit(0);
  }

  process.on("SIGINT", () => {
    console.error("SIGINT received!");
    void shutdown();
  });
  process.on("SIGTERM", () => {
    console.error("SIGTERM received!");
    void shutdown();
  });
  process.on("SIGHUP", () => {
    console.error("SIGHUP received!");
    void shutdown();
  });

  const runner = new PassRunner(ctx, undefined, tui?.bus);
  await runner.run();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
