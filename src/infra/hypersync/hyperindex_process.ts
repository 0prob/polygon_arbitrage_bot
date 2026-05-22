import { spawn, type ChildProcess } from "child_process";
import path from "path";
import type { Logger } from "../observability/logger.ts";

export interface HyperIndexProcessOptions {
  dataDir: string;
  polygonRpcUrl: string;
  katanaRpcUrl?: string;
  envioApiToken?: string;
  logger: Logger;
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

  const hiDir = path.resolve(opts.dataDir, "../hyperindex");

  async function start(): Promise<void> {
    if (proc) return;

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
    });

    _stdoutHandler = (data: Buffer) => {
      const line = data.toString().trim();
      if (line) opts.logger.debug({ source: "hyperindex", line }, "");
    };
    proc.stdout?.on("data", _stdoutHandler);

    _stderrHandler = (data: Buffer) => {
      const line = data.toString().trim();
      if (line) opts.logger.debug({ source: "hyperindex", line }, "");
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
    if (!proc) return;

    opts.logger.info("Stopping HyperIndex ingestion");
    proc.kill("SIGTERM");

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        proc?.kill("SIGKILL");
        resolve();
      }, 5000);

      if (proc) {
        const exitOnStop = () => {
          clearTimeout(timeout);
          if (proc && _exitHandler) {
            proc.off("exit", _exitHandler);
            proc.off("exit", exitOnStop);
            proc.stdout?.off("data", _stdoutHandler!);
            proc.stderr?.off("data", _stderrHandler!);
          }
          resolve();
        };
        proc.on("exit", exitOnStop);
      } else {
        clearTimeout(timeout);
        resolve();
      }
    });

    proc = null;
  }

  function isRunning(): boolean {
    return proc !== null && proc.exitCode === null;
  }

  return { start, stop, isRunning };
}
