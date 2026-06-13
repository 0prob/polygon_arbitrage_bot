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
import "../infra/garbage/garbage-tracker.ts"; // Ensure garbage list starts loading early
import { performOneTimeGarbageCleanup } from "../infra/garbage/garbage-tracker.ts";
import { HealthServer } from "../infra/observability/health_server.ts";
import { filterArchivalRpcUrls } from "../infra/rpc/archival.ts";
import { DEFAULTS } from "../config/defaults.ts";

async function main() {
  const useTui = process.argv.includes("--tui");
  const resetHasura = process.argv.includes("--reset-hasura");
  const hyperindexReset = process.argv.includes("--hyperindex-reset") || process.argv.includes("--force-full-reset");
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

  // Resolve RPC list for HyperIndex: prefer .env-provided endpoints (after removing any
  // that do not support required historical calls), only fall back to free public RPCs
  // (similarly filtered) if no usable .env ones.
  const rawRpcs = config.rpc.polygonRpcUrls;
  const hasUserEnvRpcs = !!(process.env.POLYGON_RPC_URLS || process.env.POLYGON_RPC_URL || process.env.POLYGON_RPC);
  let indexerRpcs: string[];
  if (hasUserEnvRpcs && rawRpcs.length > 0) {
    const good = await filterArchivalRpcUrls(rawRpcs);
    if (good.length > 0) {
      indexerRpcs = good;
      logger.info({ count: good.length, rpcs: good }, "HyperIndex using filtered endpoints from .env (archival support verified)");
    } else {
      const freeGood = await filterArchivalRpcUrls(DEFAULTS.rpc.polygonRpcUrls);
      indexerRpcs = freeGood.length > 0 ? freeGood : rawRpcs;
      logger.warn({ using: indexerRpcs }, "No .env RPCs passed archival probe — falling back to filtered public RPCs for HyperIndex");
    }
  } else {
    const good = await filterArchivalRpcUrls(rawRpcs.length ? rawRpcs : DEFAULTS.rpc.polygonRpcUrls);
    indexerRpcs = good.length > 0 ? good : rawRpcs;
  }

  const hyperIndexMonitor = new HyperIndexMonitor({
    processOptions: {
      dataDir: config.paths.dataDir,
      polygonRpcUrls: indexerRpcs,
      envioApiToken: config.envioApiToken,
      logger,
      eventBus: useTui ? bus : undefined,
      hasuraUrl: config.hasuraUrl || undefined,
      hasuraSecret: config.hasuraSecret || undefined,
      // Only clear Hasura metadata on explicit request (e.g. after a full reset).
      // Clearing on every start causes unnecessary GraphQL disruption.
      clearHasuraMetadataOnStart: resetHasura || hyperindexReset,
      // Nuclear reset: force-remove all Docker containers + volumes for 409 recovery + full table recreation.
      forceFullReset: hyperindexReset,
    },
    logger,
    checkIntervalMs: 10_000,
    // HyperSync free-tier rate limit waits can be 41-45s (60 req/min window reset).
    // Stall threshold must exceed this or the monitor kills HyperIndex mid-wait and
    // causes an immediate restart loop. 60s gives a full rate-limit cycle of headroom.
    maxStallMs: 60_000,
    // Warn at 200 blocks lag, only restart at 400 (2x) to avoid churn on transient catch-up.
    maxLagBlocks: 200,
  });

  try {
    await hyperIndexMonitor.prepare();
  } catch (err) {
    logger.warn({ err }, "Failed to start HyperIndex, continuing without it");
  }

  // One-time historical garbage cleanup (scans existing PoolMeta in Hasura)
  if (config.hasuraUrl) {
    try {
      const cleaned = await performOneTimeGarbageCleanup(config.hasuraUrl, config.hasuraSecret || "");
      if (cleaned > 0) {
        logger.info(`One-time garbage cleanup marked ${cleaned} new bad addresses from historical data`);
      }
    } catch (err) {
      logger.warn({ err }, "One-time garbage cleanup scan failed (non-fatal)");
    }
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
      } catch (err) {
        logger?.warn?.({ err }, "Chain head fetcher failed");
        return 0;
      }
    };
    hyperIndexMonitor.setChainHeadFetcher(headFetcher);
  }

  if (ctx.hyperSync) {
    hyperIndexMonitor.setHyperSyncService(ctx.hyperSync);
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

  const tui = useTui ? createTui(bus, logger) : null;
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
    } catch (err) {
      logger?.warn?.({ err }, "Sync status timer failed");
    }
  }, 5000);

  const runner = new PassRunner(ctx, undefined, tui?.bus);
  await runner.run();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
