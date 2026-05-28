import { spawn, execSync, type ChildProcess } from "child_process";
import path from "path";
import type { Logger } from "../observability/logger.ts";

interface HyperIndexStatusEvent {
  type: "hyperindex_status";
  status: string;
  syncedBlock: number;
  remoteBlock: number;
  chain?: string;
}

type EventBusLike = { emit(event: HyperIndexStatusEvent): void };

export interface HyperIndexProcessOptions {
  dataDir: string;
  /** Vetted list of RPC URLs (from .env filtered for support, or free public fallbacks).
   *  Passed as POLYGON_RPC_URLS (comma-joined) so the effect client can use viem fallback.
   */
  polygonRpcUrls: string[];
  katanaRpcUrl?: string;
  envioApiToken?: string;
  logger: Logger;
  eventBus?: EventBusLike;
}

export interface HyperIndexProcess {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  isRunning: () => boolean;
}

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

  function parseEnvioLine(line: string): void {
    const bus = opts.eventBus;
    if (!bus) return;

    const chainMatch = line.match(/^\[([^\]]+)\]/);
    const chain = chainMatch && !chainMatch[1].includes(":") ? chainMatch[1].toLowerCase() : undefined;

    const trimmed = line.replace(/^\[.*?\]\s*/, "").toLowerCase();

    // HyperIndex / Envio often prints event throughput during backfill, e.g.:
    // "processed 123456 events", "backfill  2345 events/s", "X events @ Y eps"
    // Capture any such numbers for diagnostics (we surface via debug logs + can extend status later).
    const eventRateMatch = trimmed.match(/(\d{3,})\s*(?:events?|evts?)\s*(?:\/\s*s|per\s*s|\/s|s\b|@\s*(\d+)|eps|\/sec)/i);
    if (eventRateMatch) {
      // Just log at debug level; the TUI/monitor already has blk/s. This helps raw debugging of "events per second".
      opts.logger.debug({ line, parsedEps: eventRateMatch[1] }, "HyperIndex event throughput hint from stdout");
    }
    // Also catch bare "N events" near large numbers in progress lines
    if (trimmed.includes("event")) {
      const evMatch = trimmed.match(/(\d{4,})\s*events?/);
      if (evMatch) {
        opts.logger.debug({ line, eventCount: evMatch[1] }, "HyperIndex event count from stdout");
      }
    }

    const blockMatch = trimmed.match(/(\d{5,})\s*->\s*(\d{5,})/);
    if (blockMatch) {
      const synced = Math.max(_lastParsedBlock, parseInt(blockMatch[1], 10));
      const remote = Math.max(_lastRemoteBlock, parseInt(blockMatch[2], 10));
      emitStatus("syncing", synced, remote, chain);
      return;
    }

    const progressMatch = trimmed.match(/(\d{5,})\s*\/\s*(\d{5,})/);
    if (progressMatch) {
      const synced = Math.max(_lastParsedBlock, parseInt(progressMatch[1], 10));
      const remote = Math.max(_lastRemoteBlock, parseInt(progressMatch[2], 10));
      emitStatus("syncing", synced, remote, chain);
      return;
    }

    if (trimmed.includes("indexed") || trimmed.includes("synced") || trimmed.includes("caught")) {
      const nums = trimmed.match(/\d{5,}/g);
      if (nums) {
        const block = Math.max(_lastParsedBlock, parseInt(nums[nums.length - 1], 10));
        emitStatus("synced", block, block, chain);
      }
      return;
    }

    // Detect "connected" or "listening" or "ready" indicators from envio
    if (trimmed.includes("connected") || trimmed.includes("listening") || trimmed.includes("ready") || trimmed.includes("running")) {
      if (_lastParsedBlock === 0) {
        emitStatus("running", 0, 0, chain);
      }
      return;
    }

    // Detect graphql or hasura startup
    if (trimmed.includes("graphql") || trimmed.includes("hasura") || trimmed.includes("docker")) {
      if (_lastParsedBlock === 0) {
        emitStatus("running", 0, 0, chain);
      }
      return;
    }

    if (trimmed.includes("error") || trimmed.includes("fail")) {
      emitStatus("error", _lastParsedBlock, _lastRemoteBlock, chain);
    }
  }

  async function start(): Promise<void> {
    if (proc) return;

    // Explicitly stop any existing envio instances to clear Docker containers/ports
    try {
      opts.logger.info("Ensuring previous HyperIndex instances are stopped...");
      execSync("bunx envio stop", { cwd: hiDir, stdio: "ignore", timeout: 5000 });
    } catch (e: unknown) {
      const error = e as { code?: string; message?: string };
      if (error.code === "ETIMEDOUT") {
        opts.logger.warn("envio stop timed out, continuing anyway...");
      } else {
        opts.logger.debug({ err: error.message }, "envio stop failed, likely nothing to stop");
      }
    }

    freePort(9898);
    freePort(8080);
    _stderrBuffer = [];

    const rpcList = opts.polygonRpcUrls && opts.polygonRpcUrls.length > 0 ? opts.polygonRpcUrls : [];
    const env: Record<string, string> = {
      ...process.env,
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
    } as Record<string, string>;

    if (rpcList.length > 0) {
      // Provide plural for fallback support inside effects + singular for any legacy
      env.POLYGON_RPC_URLS = rpcList.join(",");
      env.POLYGON_RPC_URL = rpcList[0];
    }
    // If empty list, let the hyperindex rpc_client fall back to its internal default free public

    if (opts.katanaRpcUrl) {
      env.KATANA_RPC_URL = opts.katanaRpcUrl;
    }
    if (opts.envioApiToken) {
      env.ENVIO_API_TOKEN = opts.envioApiToken;
    } else {
      opts.logger.warn(
        "No ENVIO_API_TOKEN provided. HyperSync/HyperIndex will be rate-limited (per 2026 Envio requirements). Generate one at https://envio.dev/app/api-tokens",
      );
    }

    opts.logger.info({ hyperindexDir: hiDir }, "Starting HyperIndex ingestion");

    proc = spawn("bunx", ["envio", "dev"], {
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
      if (_stderrBuffer.length > 10) _stderrBuffer.shift();

      parseEnvioLine(line);
    };
    proc.stderr?.on("data", _stderrHandler);

    _exitHandler = (code, signal) => {
      if (code !== 0 && code !== null) {
        opts.logger.error({ code, signal, lastStderr: _stderrBuffer.join("\n") }, "HyperIndex process crashed");
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

        // Final explicit envio stop to clean up Docker containers
        try {
          opts.logger.info("Running explicit envio stop to clean up containers");
          execSync("bunx envio stop", { cwd: hiDir, stdio: "ignore", timeout: 10000 });
        } catch (err) {
          opts.logger.warn({ err }, "envio stop failed during cleanup");
        }
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
