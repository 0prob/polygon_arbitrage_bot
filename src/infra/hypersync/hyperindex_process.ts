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
  polygonRpcUrl: string;
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
      execSync("bunx envio stop", { cwd: hiDir, stdio: "ignore", timeout: 15000 });
    } catch {
      // ignore
    }

    freePort(9898);
    _stderrBuffer = [];

    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      POLYGON_RPC_URL: opts.polygonRpcUrl,
    };
    if (opts.katanaRpcUrl) {
      env.KATANA_RPC_URL = opts.katanaRpcUrl;
    }
    if (opts.envioApiToken) {
      env.ENVIO_API_TOKEN = opts.envioApiToken;
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
