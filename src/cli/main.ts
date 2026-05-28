import { loadConfig } from "../config/loader.ts";
import { bootApplication } from "../orchestrator/boot.ts";
import { PassRunner } from "../orchestrator/runner.ts";
import { shutdownApplication } from "../orchestrator/shutdown.ts";
import { createRootLogger } from "../infra/observability/logger.ts";
import { EventBus } from "../tui/events.ts";
import { createTui } from "../tui/main.ts";
import { mkdir } from "fs/promises";
import { join } from "path";
import { execSync } from "child_process";
import { HyperIndexMonitor } from "../infra/resilience/hyperindex_monitor.ts";
import { HealthServer } from "../infra/observability/health_server.ts";

async function main() {
  const useTui = process.argv.includes("--tui");
  const useCleanup = process.argv.includes("--cleanup");
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

  if (useCleanup) {
    logger.info("Running pre-flight cleanup");
    try {
      execSync("bash scripts/cleanup.sh", { stdio: "inherit", timeout: 30000 });
    } catch (err) {
      logger.warn({ err }, "Cleanup script failed (continuing anyway)");
    }
  }

  const hyperIndexMonitor = new HyperIndexMonitor({
    processOptions: {
      dataDir: config.paths.dataDir,
      polygonRpcUrl: config.rpc.polygonRpcUrls[0],
      envioApiToken: config.envioApiToken,
      logger,
      eventBus: useTui ? bus : undefined,
    },
    logger,
    checkIntervalMs: 10_000,
  });

  try {
    await hyperIndexMonitor.prepare();
  } catch (err) {
    logger.warn({ err }, "Failed to start HyperIndex, continuing without it");
  }

  const ctx = await bootApplication(config, undefined, logger, hyperIndexMonitor);

  // Wire event bus to monitor for stall detection
  bus.on((ev) => {
    if (ev.type === "hyperindex_status" && (ev.status === "syncing" || ev.status === "synced")) {
      hyperIndexMonitor.updateSyncedBlock(ev.syncedBlock, ev.remoteBlock);
    }
  });

  await hyperIndexMonitor.start();

  // Wire real chain head fetcher for accurate lag calculation (prefers HyperRPC) - implements item 1
  if (ctx.publicClient) {
    const headFetcher = async () => {
      try {
        if (ctx.hyperRpc) {
          return Number(await ctx.hyperRpc.blockNumber());
        }
        const block = await ctx.publicClient.getBlock({ blockTag: "latest" });
        return Number(block.number);
      } catch {
        return 0;
      }
    };
    hyperIndexMonitor.setChainHeadFetcher(headFetcher);
  }

  const healthServer = new HealthServer(9090, {
    metrics: ctx.metrics,
    rpcCircuit: ctx.rpcCircuit,
    hasuraCircuit: ctx.hasuraCircuit,
    hyperIndexMonitor: hyperIndexMonitor,
    getTier: () => ctx.tierManager.assess(),
  });

  try {
    await healthServer.start();
  } catch (err) {
    logger.warn({ err, port: 9090 }, "Failed to start health server");
  }

  const tui = useTui ? createTui(bus) : null;
  if (tui) {
    tui.start();
  }

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(syncStatusTimer);
    ctx.logger.warn({}, "Shutting down");
    tui?.bus.emit({ type: "shutdown" });
    tui?.stop();
    await healthServer.stop();
    await hyperIndexMonitor.stop();
    await shutdownApplication(ctx);
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Periodically surface rich sync metrics (lag + rate from real chain head) to TUI + logs - item 2
  const syncStatusTimer = setInterval(() => {
    if (!hyperIndexMonitor.isRunning()) return;
    try {
      const status = hyperIndexMonitor.getLastStatus();
      bus.emit({
        type: "hyperindex_status",
        status: status.status,
        syncedBlock: status.synced,
        remoteBlock: status.remote,
        lag: status.lag,
        syncRate: status.syncRate,
      });
    } catch {}
  }, 5000);

  const runner = new PassRunner(ctx, undefined, tui?.bus);
  await runner.run();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
