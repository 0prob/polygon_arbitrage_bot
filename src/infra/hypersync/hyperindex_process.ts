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

  const hiDir = path.resolve(opts.dataDir, "../hyperindex");

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

    // Extract chain name from [chain] prefix
    const chainMatch = line.match(/^\[([^\]]+)\]/);
    const chain = chainMatch && !chainMatch[1].includes(":") ? chainMatch[1].toLowerCase() : undefined;

    const trimmed = line.replace(/^\[.*?\]\s*/, "").toLowerCase();

    const blockMatch = trimmed.match(/(\d{5,})\s*->\s*(\d{5,})/);
    if (blockMatch) {
      _lastParsedBlock = Math.max(_lastParsedBlock, parseInt(blockMatch[2], 10));
      _lastRemoteBlock = Math.max(_lastRemoteBlock, parseInt(blockMatch[2], 10));
      bus.emit({
        type: "hyperindex_status",
        status: "syncing",
        syncedBlock: _lastParsedBlock,
        remoteBlock: _lastRemoteBlock,
        chain,
      });
      return;
    }

    const progressMatch = trimmed.match(/(\d{5,})\s*\/\s*(\d{5,})/);
    if (progressMatch) {
      _lastParsedBlock = Math.max(_lastParsedBlock, parseInt(progressMatch[1], 10));
      _lastRemoteBlock = Math.max(_lastRemoteBlock, parseInt(progressMatch[2], 10));
      bus.emit({
        type: "hyperindex_status",
        status: "syncing",
        syncedBlock: _lastParsedBlock,
        remoteBlock: _lastRemoteBlock,
        chain,
      });
      return;
    }

    if (trimmed.includes("indexed") || trimmed.includes("synced") || trimmed.includes("caught")) {
      const nums = trimmed.match(/\d{5,}/g);
      if (nums) {
        _lastParsedBlock = Math.max(_lastParsedBlock, parseInt(nums[nums.length - 1], 10));
        bus.emit({
          type: "hyperindex_status",
          status: "synced",
          syncedBlock: _lastParsedBlock,
          remoteBlock: _lastParsedBlock,
          chain,
        });
      }
    }

    if (trimmed.includes("error") || trimmed.includes("fail")) {
      bus.emit({
        type: "hyperindex_status",
        status: "error",
        syncedBlock: _lastParsedBlock,
        remoteBlock: _lastRemoteBlock,
        chain,
      });
    }
  }

  async function start(): Promise<void> {
    if (proc) return;

    freePort(9898);

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
      parseEnvioLine(line);
    };
    proc.stderr?.on("data", _stderrHandler);

    _exitHandler = (code, signal) => {
      opts.logger.warn({ code, signal }, "HyperIndex process exited");
      proc = null;
    };
    proc.on("exit", _exitHandler);

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  async function stop(): Promise<void> {
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
