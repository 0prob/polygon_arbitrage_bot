import { spawn, execSync, type ChildProcess } from "child_process";
import path from "path";
import { readFile, stat } from "fs/promises";
import type { Logger } from "../observability/logger.ts";
import { EnvioLineParser, type EnvioLineParsedInfo } from "./envio_line_parser.ts";

interface HyperIndexStatusEvent {
  type: "hyperindex_status";
  status: string;
  syncedBlock: number;
  remoteBlock: number;
  chain?: string;
  /** Short prefix of active ENVIO key (for TUI) */
  envioKeyPrefix?: string;
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

  /**
   * If true (default), automatically run the token registry auto-update after the HyperIndex
   * process shuts down gracefully. This promotes any cold tokens discovered during
   * the run into the static STATIC_TOKEN_DECIMALS registry.
   */
  autoUpdateTokenRegistryOnShutdown?: boolean;
}

export interface HyperIndexProcess {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  isRunning: () => boolean;
  /** Short prefix of the ENVIO key currently active for this HyperIndex child (for TUI "ENVIO Key:" indicator) */
  getCurrentEnvioKeyPrefix?: () => string | undefined;
  /**
   * Returns rate-limit state parsed from HyperIndex process stdout, or null if none observed.
   * resetAt is a Date.now()-epoch ms timestamp when the rate-limit window is expected to reset.
   * This is the authoritative signal for the stall guard when the HyperSync SDK client
   * does not have live visibility into the child process's rate-limit state.
   */
  getProcessRateLimitInfo?: () => { resetAt: number } | null;
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
/**
 * Check if we need aggressive Docker cleanup by inspecting container states
 */
async function needsAggressiveCleanup(): Promise<boolean> {
  try {
    // Check for containers marked for removal or in error states
    const listCmd = `docker ps -a --filter name=envio- --format "{{.Status}}" 2>/dev/null || true`;
    const output = execSync(listCmd, { encoding: "utf8", timeout: 3000 });

    // Look for problematic states
    const lines = output.trim().split("\n").filter(Boolean);
    const hasStuckContainers = lines.some(
      (status) => status.includes("marked for removal") || status.includes("Dead") || status.includes("(unhealthy)"),
    );

    return hasStuckContainers;
  } catch {
    // If we can't check, err on the side of caution
    return true;
  }
}

/**
 * Lightweight cleanup for normal startup
 */
async function performLightweightDockerCleanup(hiDir: string): Promise<void> {
  try {
    // Just stop envio and clean running containers
    execSync("bunx envio stop", { cwd: hiDir, stdio: "ignore", timeout: 6000 });

    // Remove any still-running envio containers
    const bulkRm = "docker rm -f $(docker ps -q --filter name=envio- 2>/dev/null) 2>/dev/null || true";
    execSync(bulkRm, { stdio: "ignore", timeout: 3000 });
  } catch {
    // Errors are non-critical for lightweight cleanup
  }
}

/**
 * Aggressive cleanup for stuck containers or force reset
 */
async function performAggressiveDockerCleanup(hiDir: string, forceFullReset: boolean): Promise<void> {
  try {
    // Stop envio first
    execSync("bunx envio stop", { cwd: hiDir, stdio: "ignore", timeout: 8000 });

    // Force remove all envio containers (including stopped ones)
    const bulkRm = "docker rm -f $(docker ps -aq --filter name=envio- 2>/dev/null) 2>/dev/null || true";
    execSync(bulkRm, { stdio: "ignore", timeout: 5000 });

    // Individual container cleanup for stubborn cases
    const listCmd = `docker ps -a --filter name=envio- --format "{{.ID}}" 2>/dev/null || true`;
    const containerIds = execSync(listCmd, { encoding: "utf8", timeout: 4000 }).trim();
    if (containerIds) {
      for (const id of containerIds.split("\n").filter(Boolean)) {
        try {
          execSync(`docker rm -f ${id}`, { stdio: "ignore", timeout: 2000 });
        } catch {
          // Individual failures are not critical
        }
      }
    }

    // Clean volumes only on force reset
    if (forceFullReset) {
      execSync("docker volume rm $(docker volume ls -q --filter name=envio- 2>/dev/null) 2>/dev/null || true", {
        stdio: "ignore",
        timeout: 5000,
      });
    }
  } catch {
    // Errors are logged but not critical
  }
}

/**
 * Automatically runs `envio codegen` if the schema or config is newer than the generated types.
 * This eliminates the common manual step after editing hyperindex/schema.graphql or config.yaml.
 * Beneficial for dev UX, prevents type mismatches in handlers/effects, and reduces "forgot to codegen" errors.
 * Safe to call often (cheap mtime check; codegen is idempotent-ish).
 */
export async function ensureCodegenUpToDate(hiDir: string, logger?: Logger): Promise<void> {
  const schemaPath = path.join(hiDir, "schema.graphql");
  const configPath = path.join(hiDir, "config.yaml");
  const generatedTypesPath = path.join(hiDir, ".envio/types.d.ts");

  try {
    const [schemaStat, configStat] = await Promise.all([
      stat(schemaPath),
      stat(configPath),
    ]);

    let generatedStat: Awaited<ReturnType<typeof stat>> | undefined;
    try {
      generatedStat = await stat(generatedTypesPath);
    } catch {
      // No generated file yet → definitely need codegen
      generatedStat = { mtimeMs: 0 } as any;
    }

    const sourceMtime = Math.max(schemaStat.mtimeMs, configStat.mtimeMs);
    if (!generatedStat || sourceMtime > generatedStat.mtimeMs) {
      logger?.info("HyperIndex schema.graphql or config.yaml is newer than generated types — running `envio codegen` automatically...");
      execSync("bunx envio codegen", {
        cwd: hiDir,
        stdio: "inherit",  // Show output so user sees it happened
        timeout: 30000,
      });
      logger?.info("✅ HyperIndex codegen completed (types refreshed).");
    }
  } catch (err: any) {
    // Non-fatal: if files missing or codegen fails (e.g. no envio in path), just warn.
    // Normal startup can still proceed; user will get TS errors later if types stale.
    if (err.code !== "ENOENT") {
      logger?.warn({ err: err.message }, "Could not auto-run HyperIndex codegen (non-fatal; run manually if types are stale)");
    }
  }
}

export function createHyperIndexProcess(opts: HyperIndexProcessOptions): HyperIndexProcess {
  let proc: ChildProcess | null = null;
  let _weStartedIndexer = false;
  let _stdoutHandler: ((data: Buffer) => void) | null = null;
  let _stderrHandler: ((data: Buffer) => void) | null = null;
  let _exitHandler: ((code: number | null, signal: string | null) => void) | null = null;
  let _lastParsedBlock = 0;
  let _lastRemoteBlock = 0;
  let _lastEmitTime = 0;
  let _statusTimer: ReturnType<typeof setInterval> | null = null;
  let _stderrBuffer: string[] = [];
  let _hasDoneReactiveHasuraClear = false;
  // Rate-limit info parsed from HyperIndex stdout (reset epoch ms, or null if not rate-limited)
  let _processRateLimitResetAt: number | null = null;

  // Refactored line parser for better maintainability
  const envioLineParser = new EnvioLineParser();

  /** Short prefix of the ENVIO_API_TOKEN chosen for the current hyperindex child process run (for TUI) */
  let _currentEnvioKeyPrefix: string | undefined;

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
      envioKeyPrefix: _currentEnvioKeyPrefix,
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
  /**
   * Best-effort run of the token registry auto-update after HyperIndex shutdown.
   * This promotes any cold tokens discovered via RPC (in effects) into the static registry
   * used by the indexer (no more manual gentok).
   */
  function runGentokAuto(hiDir: string, logger: Logger): void {
    // Fire and forget — we don't want shutdown to be blocked by this.
    setTimeout(() => {
      try {
        logger.info("Running generate-tokens:auto (self-updating token registry) after HyperIndex shutdown...");
        const child = spawn("bun", ["run", "--cwd", hiDir, "generate-tokens:auto"], {
          stdio: "ignore",
          detached: true,
        });
        child.unref();

        // Give it a generous amount of time, then we stop caring
        setTimeout(() => {
          try {
            child.kill();
          } catch {}
        }, 90_000);
      } catch (err) {
        logger.debug({ err }, "Failed to spawn generate-tokens:auto after shutdown (non-fatal)");
      }
    }, 0);
  }

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
   * REFACTORED: Focused parser using EnvioLineParser for better maintainability.
   * Handles all activity tracing from the HyperIndex (Envio) process.
   */
  function parseEnvioLine(line: string): void {
    // Parse the line using the focused parser
    const parsed = envioLineParser.parse(line);

    // Log every single line for complete activity tracing (debug level to avoid duplication)
    opts.logger.debug({ source: "hyperindex", raw: line, parsed }, "HyperIndex output");

    // Handle error suppression summaries
    if (parsed.flushSummary) {
      opts.logger.warn({ source: "hyperindex", suppressedErrors: parsed.flushSummary }, "Error suppression summary");
    }

    // Skip processing if this is a suppressed transient error
    if (parsed.shouldSuppress) {
      opts.logger.debug({ source: "hyperindex", raw: line, eventType: parsed.eventType }, "Suppressed transient error");
      return;
    }

    // Handle different event types
    switch (parsed.eventType) {
      case "throughput":
        handleThroughputEvent(parsed);
        break;

      case "progress":
        handleProgressEvent(parsed);
        break;

      case "slow_handler":
        handleSlowHandlerEvent(parsed);
        break;

      case "lifecycle":
        handleLifecycleEvent(parsed);
        break;

      case "error":
      case "transient_error":
        handleErrorEvent(parsed);
        break;

      case "pipeline_bottleneck":
        opts.logger.warn(
          { source: "hyperindex", raw: line },
          "HyperIndex PIPELINE SPLIT / bottleneck indicator (Loaders/Handlers/DB Writes)",
        );
        break;
    }

    // Handle reactive Hasura metadata clearing
    if (!_hasDoneReactiveHasuraClear && opts.hasuraUrl && /metadata-warning/i.test(line)) {
      _hasDoneReactiveHasuraClear = true;
      opts.logger.warn({ source: "hyperindex" }, "Detected Envio metadata-warnings — triggering one-time Hasura metadata clear");
      clearHasuraMetadata(opts.hasuraUrl, opts.hasuraSecret, opts.logger).catch((err) => {
        opts.logger.warn({ err }, "Reactive Hasura clear failed");
      });
    }
  }

  function handleThroughputEvent(parsed: EnvioLineParsedInfo): void {
    if (parsed.eventsPerSec) {
      opts.logger.info({ source: "hyperindex", eventsPerSec: parsed.eventsPerSec }, "HyperIndex throughput");
    } else if (parsed.eventCount) {
      opts.logger.debug({ source: "hyperindex", eventCount: parsed.eventCount }, "HyperIndex event count");
    }
  }

  function handleProgressEvent(parsed: EnvioLineParsedInfo): void {
    if (parsed.syncedBlock && parsed.remoteBlock) {
      const synced = Math.max(_lastParsedBlock, parsed.syncedBlock);
      const remote = Math.max(_lastRemoteBlock, parsed.remoteBlock);
      emitStatus(parsed.status || "syncing", synced, remote, parsed.chain);
    }
  }

  function handleSlowHandlerEvent(parsed: EnvioLineParsedInfo): void {
    opts.logger.info({ source: "hyperindex", syncedBlock: parsed.syncedBlock }, "HyperIndex possible slow handler or effect");

    // Update progress from slow handler block info
    if (parsed.syncedBlock) {
      _lastParsedBlock = Math.max(_lastParsedBlock, parsed.syncedBlock);
      emitStatus("syncing", _lastParsedBlock, _lastRemoteBlock, parsed.chain);
    }
  }

  function handleLifecycleEvent(parsed: EnvioLineParsedInfo): void {
    if (parsed.status === "indexer_ready") {
      opts.logger.warn(
        { source: "hyperindex", milestone: "indexer_ready" },
        "HyperIndex reached 'Starting indexing!' — real event processing should begin",
      );
      emitStatus("indexer_ready", _lastParsedBlock, _lastRemoteBlock, parsed.chain);
    } else if (parsed.status === "synced" && parsed.syncedBlock) {
      emitStatus("synced", parsed.syncedBlock, parsed.remoteBlock || parsed.syncedBlock, parsed.chain);
    } else if (parsed.status === "running") {
      if (_lastParsedBlock === 0) emitStatus("running", 0, 0, parsed.chain);
    }
  }

  function handleErrorEvent(parsed: EnvioLineParsedInfo): void {
    // Capture rate-limit reset time from stdout so the monitor's stall guard can use it
    if (parsed.rateLimitResetAt) {
      _processRateLimitResetAt = parsed.rateLimitResetAt;
    }

    if (parsed.logLevel) {
      opts.logger[parsed.logLevel as "error" | "warn"](
        {
          source: "hyperindex",
          raw: undefined,
          eventType: parsed.eventType,
          ...(parsed.rateLimitResetAt ? { rateLimitResetAt: parsed.rateLimitResetAt } : {}),
        },
        "HyperIndex error/warning",
      );
    }

    if (parsed.status === "error") {
      emitStatus("error", _lastParsedBlock, _lastRemoteBlock, parsed.chain);
    }
  }

  async function start(): Promise<void> {
    if (proc) return;

    // Auto-ensure Envio codegen is up-to-date before starting (or restarting) the indexer.
    // This automates the previously manual "cd hyperindex && bunx envio codegen" step after any
    // schema.graphql or config.yaml edit. Greatly improves dev experience and prevents stale types.
    await ensureCodegenUpToDate(hiDir, opts.logger);

    // Envio line parser handles its own state management now - no manual reset needed

    // === OPTIMIZED DOCKER CLEANUP: Smart cleanup based on actual container state ===
    // Only do aggressive cleanup if we detect stuck containers or on explicit force reset
    const shouldForceCleanup = opts.forceFullReset || (await needsAggressiveCleanup());

    if (shouldForceCleanup) {
      opts.logger.info("Performing aggressive Docker cleanup (stuck containers or explicit reset)...");
      await performAggressiveDockerCleanup(hiDir, opts.forceFullReset || false);
    } else {
      // Fast path: just stop envio gracefully and clean running containers
      opts.logger.debug("Performing lightweight Docker cleanup...");
      await performLightweightDockerCleanup(hiDir);
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

    // === SINGLE-KEY PASS-THROUGH ===
    // Paid Envio starter plan = 200 rpm. No token rotation needed.
    // Priority: explicit opts > environment > .env files.
    const explicitToken = opts.envioApiToken || process.env.ENVIO_API_TOKEN;
    if (explicitToken) {
      env.ENVIO_API_TOKEN = explicitToken;
      _currentEnvioKeyPrefix = explicitToken.slice(0, 8) + "…";
      opts.logger.info({ tokenPrefix: _currentEnvioKeyPrefix }, "HyperIndex using single ENVIO_API_TOKEN (paid plan — 200 rpm)");
    } else {
      _currentEnvioKeyPrefix = undefined;
      opts.logger.warn("No ENVIO_API_TOKEN provided. HyperSync/HyperIndex will be heavily rate-limited. Set ENVIO_API_TOKEN in .env.");
    }

    // === LIVE DEBUG + PROGRESS HANDLER COORDINATION ===
    // When the user sets a high POLYGON_START_BLOCK (e.g. 86M) for fast live-tail
    // on a free token, also tell the progress onBlock handler inside the child
    // to start from the same high block. This prevents the Envio error:
    //   "The start block for onBlock handler "IndexerProgressRealtime" is less than the chain start block"
    const chainStartStr = env.POLYGON_START_BLOCK || rootEnvVars.POLYGON_START_BLOCK || process.env.POLYGON_START_BLOCK;
    const chainStartNum = chainStartStr ? Number(chainStartStr) : 0;
    if (chainStartNum >= 80_000_000) {
      env.INDEXER_PROGRESS_REALTIME_START = String(chainStartNum);
      opts.logger.info(
        { chainStart: chainStartNum, set: "INDEXER_PROGRESS_REALTIME_START" },
        "High POLYGON_START_BLOCK detected — aligning IndexerProgressRealtime onBlock handler start for live-debug mode",
      );
    }

    // Forward the RPM target so any future code inside the child (or effects) can be aware.
    const rpmTarget = Number(process.env.HYPERSYNC_RPM_TARGET || 200);
    if (!env.HYPERSYNC_RPM_TARGET) {
      env.HYPERSYNC_RPM_TARGET = String(rpmTarget);
    }

    // === AUTONOMOUS DEBUG LOOP SUPPORT ===
    // Force richer logs from the Envio side (hypersync client rate limiting, handler timing, etc.)
    // so our new instrumentation in parseEnvioLine catches even more bottleneck detail.
    env.RUST_LOG = env.RUST_LOG || "info,hypersync_client=debug,envio=debug";
    env.ENVIO_LOG_LEVEL = env.ENVIO_LOG_LEVEL || "debug";

    // === INSTRUMENTATION: Full startup trace for bottleneck diagnosis ===
    const sanitizedEnvKeys = Object.keys(env).filter(
      (k) => /^(POLYGON_|ENVIO_|HYPERSYNC_|HASURA_)/i.test(k) || k === "RUST_LOG" || k === "ENVIO_LOG_LEVEL",
    );
    const rpcCount = (env.POLYGON_RPC_URLS || env.POLYGON_RPC_URL || "").split(",").filter(Boolean).length;
    const hasToken = !!env.ENVIO_API_TOKEN;
    const startBlock = env.POLYGON_START_BLOCK || env.POLYGON_START_BLOCK || "default (config.yaml)";

    opts.logger.info(
      {
        hyperindexDir: hiDir,
        rpcEndpoints: rpcCount,
        hasEnvioToken: hasToken,
        rpmTarget,
        startBlock,
        importantEnv: sanitizedEnvKeys,
        forceFullReset: opts.forceFullReset,
        note: hasToken
          ? "Using authenticated HyperSync with paid Envio starter plan (~200 rpm)"
          : "NO ENVIO_API_TOKEN — HyperIndex will be heavily rate-limited. Set ENVIO_API_TOKEN in .env.",
      },
      opts.forceFullReset
        ? "Starting HyperIndex with FULL RESET (-r) + volume nuke (409 recovery + table recreation)"
        : "Starting HyperIndex ingestion (instrumented for bottleneck tracing)",
    );

    // Also surface the exact command for full reproducibility
    opts.logger.debug({ cmd: "bunx envio dev", cwd: hiDir }, "HyperIndex spawn command");

    const envioArgs = opts.forceFullReset ? ["envio", "dev", "-r"] : ["envio", "dev"];
    proc = spawn("bunx", envioArgs, {
      cwd: hiDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      detached: true, // Start in a new process group
    });

    _weStartedIndexer = true;

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
      // Parser handles its own cleanup
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
    // No longer need explicit flush since parser handles it internally
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
          execSync("docker rm -f $(docker ps -aq --filter name=envio- 2>/dev/null) 2>/dev/null || true", {
            stdio: "ignore",
            timeout: 5000,
          });
        } catch {}
      }

      p.on("exit", cleanup);
    });

    const shouldRunGentok = _weStartedIndexer && opts.autoUpdateTokenRegistryOnShutdown !== false;

    proc = null;
    _currentEnvioKeyPrefix = undefined;
    _weStartedIndexer = false;

    // Automatically promote any cold tokens discovered during this run into the static registry.
    // This is best-effort and runs after the indexer has fully shut down.
    if (shouldRunGentok) {
      runGentokAuto(hiDir, opts.logger);
    }
  }

  function isRunning(): boolean {
    return proc !== null && proc.exitCode === null;
  }

  function getCurrentEnvioKeyPrefix(): string | undefined {
    return _currentEnvioKeyPrefix;
  }

  function getProcessRateLimitInfo(): { resetAt: number } | null {
    if (_processRateLimitResetAt === null) return null;
    // Expire stale rate-limit info (max 120s — well past any real window)
    if (Date.now() > _processRateLimitResetAt + 120_000) {
      _processRateLimitResetAt = null;
      return null;
    }
    return { resetAt: _processRateLimitResetAt };
  }

  return { start, stop, isRunning, getCurrentEnvioKeyPrefix, getProcessRateLimitInfo };
}
