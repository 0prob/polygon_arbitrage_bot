import { loadConfig } from "../config/loader.ts";
import { bootApplication } from "../orchestrator/boot.ts";
import { PassRunner } from "../orchestrator/runner.ts";
import { shutdownApplication } from "../orchestrator/shutdown.ts";
import { createRootLogger } from "../infra/observability/logger.ts";
import { EventBus } from "../tui/events.ts";
import { createTui } from "../tui/main.ts";
import { mkdir } from "fs/promises";
import { join } from "path";
import { debugBreak, debugLog, DebugSites } from "../infra/debug/session.ts";
import { HyperIndexMonitor } from "../infra/resilience/hyperindex_monitor.ts";

async function main() {
  debugLog("arb_only_debug.ts:main", "entry", {
    argv: process.argv.slice(2),
    underDebugger: !!(process.env.BUN_INSPECT || process.env.VSCODE_INSPECTOR_OPTIONS),
  });
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

  logger.info({ hasuraUrl: config.hasuraUrl }, "Starting arb-only debug mode — assuming HyperIndex/Hasura is running externally");

  const hyperIndexMonitor = new HyperIndexMonitor({
    processOptions: {
      dataDir: config.paths.dataDir,
      polygonRpcUrls: config.rpc.polygonRpcUrls,
      envioApiToken: config.envioApiToken,
      logger,
      hasuraUrl: config.hasuraUrl || undefined,
      hasuraSecret: config.hasuraSecret || undefined,
    },
    logger,
    checkIntervalMs: 10_000,
    maxStallMs: 60_000,
    maxLagBlocks: 200,
  });
  try {
    await hyperIndexMonitor.prepare();
  } catch (err) {
    logger.warn({ err }, "HyperIndex monitor prepare (external) failed");
  }

  const ctx = await bootApplication(config, undefined, logger, hyperIndexMonitor);
  debugLog("arb_only_debug.ts:boot", "boot complete", { tier: ctx.tierManager.assess() });

  hyperIndexMonitor.setChainHeadFetcher(async () => {
    try {
      const rpcUrl = config.rpc.executionRpcUrl || (config.rpc.polygonRpcUrls && config.rpc.polygonRpcUrls[0]);
      if (!rpcUrl) return 0;
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      });
      const j = await res.json();
      const hex = j?.result;
      return hex ? parseInt(hex, 16) : 0;
    } catch (err) {
      logger?.warn?.({ err }, "Chain head fetcher failed");
      return 0;
    }
  });
  await hyperIndexMonitor.start().catch((e) => logger.warn({ e }, "monitor start warn"));

  const tui = useTui ? createTui(bus, logger) : null;
  if (tui) {
    tui.start();
  }

  const statusTimer = setInterval(() => {
    let st: { synced?: number; remote?: number; lag?: number; syncRate?: number } = {};
    try {
      st = hyperIndexMonitor.getLastStatus() ?? st;
    } catch (e) {
      logger?.debug?.({ err: e }, "External monitor status fetch failed");
    }
    bus.emit({
      type: "hyperindex_status",
      status: "external",
      syncedBlock: st.synced ?? 0,
      remoteBlock: st.remote ?? 0,
      lag: st.lag ?? 0,
      syncRate: st.syncRate ?? 0,
    });
  }, 10000);

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(statusTimer);
    try {
      await hyperIndexMonitor.stop();
    } catch (err) {
      ctx.logger.warn?.({ err }, "HyperIndex monitor stop failed during shutdown");
    }
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
  debugBreak(DebugSites.FATAL, { err: String(err) });
  console.error(err);
  process.exit(1);
});
