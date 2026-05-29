import { spawn, execSync, type ChildProcess } from "child_process";
import path from "path";
import { readFile } from "fs/promises";
import type { Logger } from "../observability/logger.ts";

interface HyperIndexStatusEvent {
  type: "hyperindex_status";
  status: string;
  syncedBlock: number;
  remoteBlock: number;
  chain?: string;
}

type EventBusLike = { emit(event: HyperIndexStatusEvent): void };

/**
 * Minimal .env file loader.
 * Ensures the HyperIndex (envio dev + its Docker containers) always sees variables
 * from the project root .env, regardless of cwd or how the parent process was invoked.
 */
async function loadEnvFile(filePath: string): Promise<Record<string, string>> {
  try {
    const content = await readFile(filePath, "utf8");
    const result: Record<string, string> = {};
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || line.startsWith("//")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      // Strip matching quotes
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key) result[key] = value;
    }
    return result;
  } catch {
    // File missing or unreadable — not fatal
    return {};
  }
}

export interface HyperIndexProcessOptions {
  dataDir: string;
  /** Vetted list of RPC URLs (from .env filtered for support, or free public fallbacks).
   *  Passed as POLYGON_RPC_URLS (comma-joined) so the effect client can use viem fallback.
   */
  polygonRpcUrls: string[];
  envioApiToken?: string;
  logger: Logger;
  eventBus?: EventBusLike;

  /** Optional Hasura connection info (used for both reactive error handling and explicit clears). */
  hasuraUrl?: string;
  hasuraSecret?: string;

  /**
   * If true, the process will clear Hasura metadata before starting the indexer.
   * Only use this for explicit reset flows. Normal starts should leave this false
   * to avoid unnecessary schema disruption and faster startup.
   */
  clearHasuraMetadataOnStart?: boolean;

  /**
   * Nuclear reset mode for debugging / recovery from stuck Docker state (e.g. 409 "marked for removal").
   * When true:
   *   - Aggressively force-removes all envio-* containers AND volumes
   *   - Forces a full environment reset (equivalent to `envio dev -r` + metadata clear)
   *   - Intended for the autonomous debug loop and manual `--hyperindex-reset` flows.
   */
  forceFullReset?: boolean;
}

export interface HyperIndexProcess {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  isRunning: () => boolean;
}

/**
 * Thin, opinionated wrapper around `envio dev` for the arbitrage bot.
 *
 * V3 Philosophy (post-2026-05):
 * - Prefer `envio stop`, `envio dev -r`, and `forceFullReset` over heavy custom Docker logic.
 * - The main value we add is:
 *     1. Reliable root .env injection
 *     2. Excellent structured logging + bottleneck tracing (our custom parseEnvioLine)
 *     3. Graceful restart + monitoring integration
 *     4. Nuclear reset support via --hyperindex-reset
 *
 * We deliberately try to stay as close as possible to stock `envio` behavior.
 */
export function createHyperIndexProcess(opts: HyperIndexProcessOptions): HyperIndexProcess {
  let proc: ChildProcess | null = null;
  let _stdoutHandler: ((data: Buffer) => void) | null = null;
  let _stderrHandler: ((data: Buffer) => void) | null = null;
  let _exitHandler: ((code: number | null, signal: string | null) => void) | null = null;
  let _lastParsedBlock = 0;
  let _lastRemoteBlock = 0;
  let _lastEmitTime = 0;
  let _statusTimer: ReturnType<typeof setInterval> | null = null;
  let _stderrBuffer: string[] = [];
  let _hasDoneReactiveHasuraClear = false;

  const hiDir = path.resolve(opts.dataDir, "../hyperindex");

  function emitStatus(status: string, synced: number, remote: number, chain?: string): void {
    const bus = opts.eventBus;
    if (!bus) return;
    _lastEmitTime = Date.now();
    _lastParsedBlock = synced;
    _lastRemoteBlock = remote;
    bus.emit({
      type: "hyperindex_status",
      status,
      syncedBlock: synced,
      remoteBlock: remote,
      chain,
    });
  }

  function freePort(port: number): void {
    try {
      const pid = execSync(`lsof -ti :${port}`, { encoding: "utf8", timeout: 2000 }).trim();
      if (pid) {
        try {
          process.kill(Number(pid), "SIGKILL");
        } catch {
          // process already gone
        }
      }
    } catch {
      // port is free
    }
  }

  /**
   * Best-effort clear of Hasura metadata.
   * Safe to call even if Hasura is not reachable.
   */
  async function clearHasuraMetadata(url: string, secret: string | undefined, logger: Logger): Promise<void> {
    const endpoint = `${url.replace(/\/$/, "")}/v1/metadata`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (secret) {
      headers["x-hasura-admin-secret"] = secret;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ type: "clear_metadata", args: {} }),
        signal: controller.signal,
      });

      if (res.ok) {
        logger.debug("Hasura metadata cleared successfully before starting HyperIndex");
      } else {
        logger.debug({ status: res.status }, "Hasura metadata clear returned non-OK (may be harmless)");
      }
    } catch (err) {
      // Non-fatal — many dev setups don't have Hasura running at this exact moment
      logger.debug({ err }, "Hasura metadata clear skipped (not reachable or timed out)");
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * INSTRUMENTATION POINT: Rich parser for tracing EVERY activity from the HyperIndex (Envio) process.
   * This is the primary tool for diagnosing bottlenecks during syncing (historical backfill vs live tail).
   *
   * Captures:
   *   - Throughput (events/s) — primary speed signal
   *   - Pipeline split signals (Loaders/Handlers/DB Writes) — major recent focus
   *   - Slow handlers/effects
   *   - Lifecycle, errors, rate limit pressure, stalls
   *   - Block progress
   *
   * EVERY line is now emitted as structured info log for full traceability.
   */
  function parseEnvioLine(line: string): void {

    const chainMatch = line.match(/^\[([^\]]+)\]/);
    const chain = chainMatch && !chainMatch[1].includes(":") ? chainMatch[1].toLowerCase() : undefined;

    const trimmedLower = line.replace(/^\[.*?\]\s*/, "").toLowerCase();
    const originalTrimmed = line.replace(/^\[.*?\]\s*/, "");

    // === CRITICAL: Log every single line from Envio for complete activity tracing ===
    opts.logger.info({ source: "hyperindex", raw: line, chain }, "HyperIndex stdout/stderr");

    // 1. High-value throughput (events per second)
    const epsMatch = originalTrimmed.match(/(\d{2,})\s*(?:events?|evts?)\s*(?:\/\s*s|per\s*s|\/s|@\s*(\d+)|eps|\/sec)/i);
    if (epsMatch) {
      const eps = parseInt(epsMatch[1], 10);
      opts.logger.info({ source: "hyperindex", eventsPerSec: eps, raw: originalTrimmed }, "HyperIndex throughput");
    }

    const bareEvents = originalTrimmed.match(/(\d{4,})\s*events?/i);
    if (bareEvents) {
      opts.logger.debug({ source: "hyperindex", eventCount: bareEvents[1] }, "HyperIndex event count");
    }

    // 2. PIPELINE SPLIT & BOTTLENECK DETECTION (Loaders / Handlers / DB Writes)
    if (/pipeline\s*split|loaders|handlers|db\s*(?:write|writes)/i.test(originalTrimmed)) {
      opts.logger.warn(
        { source: "hyperindex", raw: originalTrimmed },
        "HyperIndex PIPELINE SPLIT / bottleneck indicator (Loaders/Handlers/DB Writes)"
      );
    }

    // Slow handler / effect (very common source of backfill pain)
    if (/(V2Factory|V3Factory|PairCreated|PoolCreated|token.*meta|effect|fetchTokenMeta|slow|took\s+\d+ms)/i.test(originalTrimmed)) {
      opts.logger.info({ source: "hyperindex", raw: originalTrimmed }, "HyperIndex possible slow handler or effect");
    }

    // 3. Block progress (primary sync progress signal)
    const blockArrow = trimmedLower.match(/(\d{5,})\s*->\s*(\d{5,})/);
    if (blockArrow) {
      const synced = Math.max(_lastParsedBlock, parseInt(blockArrow[1], 10));
      const remote = Math.max(_lastRemoteBlock, parseInt(blockArrow[2], 10));
      emitStatus("syncing", synced, remote, chain);
      return;
    }

    const progressSlash = trimmedLower.match(/(\d{5,})\s*\/\s*(\d{5,})/);
    if (progressSlash) {
      const synced = Math.max(_lastParsedBlock, parseInt(progressSlash[1], 10));
      const remote = Math.max(_lastRemoteBlock, parseInt(progressSlash[2], 10));
      emitStatus("syncing", synced, remote, chain);
      return;
    }

    // 4. Lifecycle / readiness states
    if (/(indexed|synced|caught up|caught-up|live tail|following head)/i.test(originalTrimmed)) {
      const nums = originalTrimmed.match(/\d{5,}/g);
      if (nums) {
        const block = Math.max(_lastParsedBlock, parseInt(nums[nums.length - 1], 10));
        emitStatus("synced", block, block, chain);
      } else {
        emitStatus("synced", _lastParsedBlock, _lastRemoteBlock, chain);
      }
      return;
    }

    // Major milestone for autonomous debug loop: indexer has finished setup and is now consuming events
    if (/Starting indexing!/i.test(originalTrimmed)) {
      opts.logger.warn({ source: "hyperindex", milestone: "indexer_ready" }, "HyperIndex reached 'Starting indexing!' — real event processing should begin. Watch for pipeline split, throughput, and handler timing in following lines.");
      emitStatus("indexer_ready", _lastParsedBlock, _lastRemoteBlock, chain);
    }

    if (/connected|listening|ready|running|started|backfill (started|complete)/i.test(originalTrimmed)) {
      if (_lastParsedBlock === 0) emitStatus("running", 0, 0, chain);
      return;
    }

    if (/graphql|hasura|docker|container/i.test(originalTrimmed) && _lastParsedBlock === 0) {
      emitStatus("running", 0, 0, chain);
      return;
    }

    // 5. Error / warning surface (critical for bottlenecks)
    if (/error|fail|exception|panic|rate limit|quota|429|throttl|slow|stall|metadata-warning/i.test(originalTrimmed)) {
      const level = /error|fail|panic|429/i.test(originalTrimmed) ? "error" : "warn";
      opts.logger[level as "error" | "warn"]({ source: "hyperindex", raw: originalTrimmed }, "HyperIndex error/warning");

      if (/error|fail|panic/i.test(originalTrimmed)) {
        emitStatus("error", _lastParsedBlock, _lastRemoteBlock, chain);
      }
    }

    // 6. Reactive safety (Hasura metadata)
    if (
      !_hasDoneReactiveHasuraClear &&
      opts.hasuraUrl &&
      /metadata-warning/i.test(originalTrimmed)
    ) {
      _hasDoneReactiveHasuraClear = true;
      opts.logger.warn({ source: "hyperindex" }, "Detected Envio metadata-warnings — triggering one-time Hasura metadata clear");
      clearHasuraMetadata(opts.hasuraUrl, opts.hasuraSecret, opts.logger).catch((err) => {
        opts.logger.warn({ err }, "Reactive Hasura clear failed");
      });
    }
  }

  async function start(): Promise<void> {
    if (proc) return;

    // === INSTRUMENTED CLEANUP: Aggressive Docker hygiene to prevent "container marked for removal" (409) crashes ===
    // Observed in Pass 1: First start often fails with 409 on envio-hasura, causing restart delay.
    // This is a major startup bottleneck for the "hyperindex sync" debug loop.
    try {
      opts.logger.info("Ensuring previous HyperIndex instances are stopped (aggressive Docker cleanup)...");
      execSync("bunx envio stop", { cwd: hiDir, stdio: "ignore", timeout: 8000 });
    } catch (e: unknown) {
      const error = e as { code?: string; message?: string };
      if (error.code === "ETIMEDOUT") {
        opts.logger.warn("envio stop timed out, continuing anyway...");
      } else {
        opts.logger.debug({ err: error.message }, "envio stop failed, likely nothing to stop");
      }
    }

    // Docker cleanup strategy (V3-aware)
    // - Normal starts: rely primarily on `envio stop` + bulk rm (fast path)
    // - forceFullReset or repeated failures: do the full "find + per-container rm -f + volumes" (the exact steps recommended in Envio docs for 409 errors)
    try {
      opts.logger.info("Cleaning previous HyperIndex Docker state...");

      // Always try the official stop first
      try {
        execSync("bunx envio stop", { cwd: hiDir, stdio: "ignore", timeout: 8000 });
      } catch {}

      const bulkRm = "docker rm -f $(docker ps -aq --filter name=envio- 2>/dev/null) 2>/dev/null || true";
      execSync(bulkRm, { stdio: "ignore", timeout: 5000 });

      // Full forensic cleanup only when we really need it (debugging or explicit reset)
      if (opts.forceFullReset) {
        opts.logger.warn("forceFullReset active — performing deep Docker cleanup (containers + volumes)");
        try {
          const listCmd = `docker ps -a --filter name=envio- --format "{{.ID}} {{.Names}} {{.Status}}" 2>/dev/null || true`;
          const raw = execSync(listCmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 }).trim();
          if (raw) {
            raw.split('\n').forEach(line => {
              const id = line.split(' ')[0];
              if (id) execSync(`docker rm -f ${id}`, { stdio: 'ignore', timeout: 5000 });
            });
          }
          execSync("docker volume rm $(docker volume ls -q --filter name=envio- 2>/dev/null) 2>/dev/null || true", { stdio: "ignore", timeout: 5000 });
        } catch {}
      }
    } catch (e) {
      opts.logger.debug({ err: e }, "Docker cleanup encountered non-fatal error");
    }

    freePort(9898);
    if (!opts.hasuraUrl) {
      freePort(8080);
    }
    _stderrBuffer = [];

    // Explicit clear only when requested (e.g. during a deliberate reset).
    // We no longer clear on every normal start because it causes temporary
    // GraphQL disruption and slows down restarts for no benefit in most cases.
    if (opts.clearHasuraMetadataOnStart && opts.hasuraUrl) {
      try {
        opts.logger.info("Clearing Hasura metadata (explicit reset requested)...");
        await clearHasuraMetadata(opts.hasuraUrl, opts.hasuraSecret, opts.logger);
      } catch (err) {
        opts.logger.warn({ err }, "Failed to clear Hasura metadata (continuing anyway)");
      }
    }

    const rpcList = opts.polygonRpcUrls && opts.polygonRpcUrls.length > 0 ? opts.polygonRpcUrls : [];

    // Explicitly load the project root .env so that `envio dev` (and the Docker
    // containers it manages) reliably see variables like POLYGON_RPC_URLS,
    // ENVIO_API_TOKEN, POLYGON_HYPERSYNC_URL, POLYGON_START_BLOCK, etc.
    // This works even if the parent process was not started with `bun --env-file=.env`.
    const rootEnvPath = path.join(hiDir, "..", ".env");
    const rootEnvVars = await loadEnvFile(rootEnvPath);

    if (Object.keys(rootEnvVars).length > 0) {
      opts.logger.debug(
        { path: rootEnvPath, loadedKeys: Object.keys(rootEnvVars).length },
        "Loaded project root .env for HyperIndex (ensures envio dev + Docker containers see root variables)",
      );
    }

    const env: Record<string, string> = {
      ...rootEnvVars,
      ...process.env, // Shell / parent process values take precedence
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
    } as Record<string, string>;

    if (rpcList.length > 0) {
      // Provide plural for fallback support inside effects + singular for any legacy
      env.POLYGON_RPC_URLS = rpcList.join(",");
      env.POLYGON_RPC_URL = rpcList[0];
    }
    // If empty list, let the hyperindex rpc_client fall back to its internal default free public

    if (opts.envioApiToken) {
      env.ENVIO_API_TOKEN = opts.envioApiToken;
    } else {
      opts.logger.warn(
        "No ENVIO_API_TOKEN provided. HyperSync/HyperIndex will be rate-limited (per 2026 Envio requirements). Generate one at https://envio.dev/app/api-tokens",
      );
    }

    // === AUTONOMOUS DEBUG LOOP SUPPORT ===
    // Force richer logs from the Envio side (hypersync client rate limiting, handler timing, etc.)
    // so our new instrumentation in parseEnvioLine catches even more bottleneck detail.
    env.RUST_LOG = env.RUST_LOG || "info,hypersync_client=debug,envio=debug";
    env.ENVIO_LOG_LEVEL = env.ENVIO_LOG_LEVEL || "debug";

    // === INSTRUMENTATION: Full startup trace for bottleneck diagnosis ===
    const sanitizedEnvKeys = Object.keys(env).filter(k =>
      /^(POLYGON_|ENVIO_|HYPERSYNC_|HASURA_)/i.test(k) || k === 'RUST_LOG' || k === 'ENVIO_LOG_LEVEL'
    );
    const rpcCount = (env.POLYGON_RPC_URLS || env.POLYGON_RPC_URL || '').split(',').filter(Boolean).length;
    const hasToken = !!env.ENVIO_API_TOKEN;
    const startBlock = env.POLYGON_START_BLOCK || env.POLYGON_START_BLOCK || 'default (config.yaml)';

    opts.logger.info({
      hyperindexDir: hiDir,
      rpcEndpoints: rpcCount,
      hasEnvioToken: hasToken,
      startBlock,
      importantEnv: sanitizedEnvKeys,
      forceFullReset: opts.forceFullReset,
      note: hasToken
        ? 'Using authenticated HyperSync (recommended for speed)'
        : 'NO ENVIO_API_TOKEN — HyperIndex will be constrained to ~100 req/min free tier on HyperSync. Backfill will be slow. Get token at https://envio.dev/app/api-tokens'
    }, opts.forceFullReset 
      ? 'Starting HyperIndex with FULL RESET (-r) + volume nuke (409 recovery + table recreation)'
      : 'Starting HyperIndex ingestion (instrumented for bottleneck tracing)');

    // Also surface the exact command for full reproducibility
    opts.logger.debug({ cmd: 'bunx envio dev', cwd: hiDir }, 'HyperIndex spawn command');

    const envioArgs = opts.forceFullReset ? ["envio", "dev", "-r"] : ["envio", "dev"];
    proc = spawn("bunx", envioArgs, {
      cwd: hiDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      detached: true, // Start in a new process group
    });

    _stdoutHandler = (data: Buffer) => {
      const line = data.toString().trim();
      if (!line) return;
      opts.logger.debug({ source: "hyperindex", line }, "");
      parseEnvioLine(line);
    };
    proc.stdout?.on("data", _stdoutHandler);

    _stderrHandler = (data: Buffer) => {
      const line = data.toString().trim();
      if (!line) return;
      opts.logger.debug({ source: "hyperindex", line }, "");

      _stderrBuffer.push(line);
      if (_stderrBuffer.length > 30) _stderrBuffer.shift(); // Increased for better crash diagnostics

      parseEnvioLine(line);
    };
    proc.stderr?.on("data", _stderrHandler);

    _exitHandler = (code, signal) => {
      if (code !== 0 && code !== null) {
        opts.logger.error(
          { code, signal, lastStderr: _stderrBuffer.slice(-30).join("\n") },
          "HyperIndex process crashed — recent stderr below",
        );
      } else {
        opts.logger.warn({ code, signal }, "HyperIndex process exited");
      }
      _statusTimer = null;
      proc = null;
    };
    proc.on("exit", _exitHandler);

    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Emit initial status so TUI shows syncing/starting immediately
    if (proc && proc.exitCode === null) {
      // Emit "running" status to move off "starting" in TUI
      const bus = opts.eventBus;
      if (bus) {
        bus.emit({
          type: "hyperindex_status",
          status: "running",
          syncedBlock: 0,
          remoteBlock: 0,
        });
        opts.logger.info({}, "HyperIndex process started — emitted running status");
      }

      // Heartbeat timer: re-emit status every 10s so TUI never goes stale
      if (!_statusTimer) {
        _statusTimer = setInterval(() => {
          if (proc && proc.exitCode === null) {
            const bus = opts.eventBus;
            if (bus && Date.now() - _lastEmitTime > 8_000) {
              const status = _lastParsedBlock > 0 ? "syncing" : "running";
              bus.emit({
                type: "hyperindex_status",
                status,
                syncedBlock: _lastParsedBlock,
                remoteBlock: _lastRemoteBlock > 0 ? _lastRemoteBlock : _lastParsedBlock,
              });
            }
          } else if (_statusTimer) {
            clearInterval(_statusTimer);
            _statusTimer = null;
          }
        }, 10_000);
      }
    }
  }

  async function stop(): Promise<void> {
    if (_statusTimer) {
      clearInterval(_statusTimer);
      _statusTimer = null;
    }
    const p = proc;
    if (!p) {
      // Still try to stop envio just in case containers are orphans
      try {
        execSync("bunx envio stop", { cwd: hiDir, stdio: "ignore", timeout: 10000 });
      } catch {
        // ignore errors if nothing to stop
      }
      return;
    }

    opts.logger.info("Stopping HyperIndex ingestion");

    try {
      // Kill the entire process group
      if (p.pid) process.kill(-p.pid, "SIGTERM");
    } catch (err) {
      opts.logger.error({ err }, "Failed to send SIGTERM to process group");
    }

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        try {
          if (p.pid) process.kill(-p.pid, "SIGKILL");
        } catch {
          // ignore
        }
        cleanup();
        resolve();
      }, 5000);

      function cleanup(): void {
        clearTimeout(timeout);
        p!.off("exit", _exitHandler!);
        p!.off("exit", cleanup);
        p!.stdout?.off("data", _stdoutHandler!);
        p!.stderr?.off("data", _stderrHandler!);

        // Final explicit cleanup — also apply the 409 "marked for removal" force-remove logic on shutdown
        try {
          opts.logger.info("Running explicit envio stop + force container cleanup (409 workaround)");
          execSync("bunx envio stop", { cwd: hiDir, stdio: "ignore", timeout: 10000 });
        } catch (err) {
          opts.logger.warn({ err }, "envio stop failed during cleanup");
        }

        try {
          execSync("docker rm -f $(docker ps -aq --filter name=envio- 2>/dev/null) 2>/dev/null || true", { stdio: "ignore", timeout: 5000 });
        } catch {}
      }

      p.on("exit", cleanup);
    });

    proc = null;
  }

  function isRunning(): boolean {
    return proc !== null && proc.exitCode === null;
  }

  return { start, stop, isRunning };
}
