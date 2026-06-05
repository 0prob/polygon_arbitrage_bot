import { loadConfig } from "../config/loader.ts";
import { bootApplication } from "../orchestrator/boot.ts";
import { PassRunner } from "../orchestrator/runner.ts";
import { shutdownApplication } from "../orchestrator/shutdown.ts";
import { createRootLogger } from "../infra/observability/logger.ts";
import { EventBus } from "../tui/events.ts";
import { createTui } from "../tui/main.ts";
import { mkdir } from "fs/promises";
import { join } from "path";
import { HyperIndexMonitor } from "../infra/resilience/hyperindex_monitor.ts";
import { fetchIndexerProgressFromHasura } from "../infra/hypersync/hyperindex_graphql.ts";

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

  // Create monitor even in arb-only (prepare will skip process start because Hasura present).
  // This enables lag tracking, degraded mode, isHealthy, and getLastStatus() for pass_loop / TUI / status.
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

  // Wire providers for real lag computation even in external/arb-only (enables degraded mode, accurate TUI lag, status)
  hyperIndexMonitor.setIndexedHeightProvider(async () => {
    try {
      const p = await fetchIndexerProgressFromHasura(config.hasuraUrl!, config.hasuraSecret || "", logger);
      return p?.lastProcessedBlock ?? 0;
    } catch {
      return 0;
    }
  });
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
    } catch {
      return 0;
    }
  });
  await hyperIndexMonitor.start().catch((e) => logger.warn({ e }, "monitor start warn"));

  const tui = useTui ? createTui(bus) : null;
  if (tui) {
    tui.start();
  }

  // Emit real hyperindex_status (from monitor providers) so TUI shows accurate lag even in external mode
  const statusTimer = setInterval(() => {
    const monitorAny = hyperIndexMonitor as any;
    let st: any = { synced: 0, remote: 0, lag: 0, syncRate: 0, syncedBlock: 0, remoteBlock: 0 };
    try {
      if (typeof monitorAny.getLastStatus === "function") {
        st = monitorAny.getLastStatus() || st;
      }
    } catch (e) {
      // best effort for external monitor
    }
    bus.emit({
      type: "hyperindex_status",
      status: "external",
      syncedBlock: st.synced || st.syncedBlock || 0,
      remoteBlock: st.remote || st.remoteBlock || 0,
      lag: st.lag || 0,
      syncRate: st.syncRate || 0,
      discoveryMode: "broad",
    });
  }, 10000);

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(statusTimer);
    try {
      await hyperIndexMonitor.stop();
    } catch {}
    ctx.logger.warn({}, "Shutting down");
    tui?.bus.emit({ type: "shutdown" });
    tui?.stop();
    await shutdownApplication(ctx);
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const runner = new PassRunner(ctx, undefined, tui?.bus);
  await runner.run();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
