import { spawn, type ChildProcess } from "child_process";
import path from "path";
import type { Logger } from "../observability/logger.ts";

export interface HyperIndexProcessOptions {
  dataDir: string;
  polygonRpcUrl: string;
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

  const hiDir = path.resolve(opts.dataDir, "../hyperindex");

  async function start(): Promise<void> {
    if (proc) return;

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      POLYGON_RPC_URL: opts.polygonRpcUrl,
    };
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

    proc.stdout?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) opts.logger.debug({ source: "hyperindex", line }, "");
    });

    proc.stderr?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) opts.logger.debug({ source: "hyperindex", line }, "");
    });

    proc.on("exit", (code, signal) => {
      opts.logger.warn({ code, signal }, "HyperIndex process exited");
      proc = null;
    });

    // Wait a moment for process to start
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
        proc.on("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
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
