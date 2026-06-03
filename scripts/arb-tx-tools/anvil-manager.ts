import { spawn, ChildProcess } from "child_process";

export interface ForkInfo {
  rpcUrl: string;
  forkBlock: number;
  pid: number;
}

export class AnvilManager {
  private process: ChildProcess | null = null;
  private info: ForkInfo | null = null;

  isRunning(): boolean {
    return this.process !== null && this.info !== null;
  }

  getInfo(): ForkInfo | null {
    return this.info;
  }

  async startFork(options?: { forkBlockNumber?: number; port?: number; rpcUrl?: string }): Promise<ForkInfo> {
    if (this.isRunning()) {
      return this.info!;
    }

    const rpcUrl = options?.rpcUrl || process.env.POLYGON_RPC_URL;
    if (!rpcUrl) {
      throw new Error("POLYGON_RPC_URL is not set (or pass rpcUrl in options). Set it in .env or pass via --env-file.");
    }

    const port = options?.port ?? parseInt(process.env.FORK_PORT ?? "8545", 10);
    const forkBlockNumber = options?.forkBlockNumber;

    const args = ["--fork-url", rpcUrl, "--port", String(port), "--silent"];
    if (forkBlockNumber) {
      args.push("--fork-block-number", String(forkBlockNumber));
    }

    return new Promise((resolve, reject) => {
      const proc = spawn("anvil", args, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      });

      const timeout = setTimeout(() => {
        reject(new Error("Anvil fork did not start within 15s. Check that anvil is installed and POLYGON_RPC_URL is valid."));
      }, 15000);

      let outputBuffer = "";

      const onData = (chunk: Buffer) => {
        outputBuffer += chunk.toString();
        if (outputBuffer.includes("Listening on")) {
          clearTimeout(timeout);
          this.process = proc;
          this.info = {
            rpcUrl: `http://127.0.0.1:${port}`,
            forkBlock: forkBlockNumber ?? 0,
            pid: proc.pid!,
          };
          resolve(this.info);
        }
      };

      proc.stdout?.on("data", onData);
      proc.stderr?.on("data", onData);

      proc.on("error", (err) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to spawn anvil: ${err.message}`));
      });

      proc.on("exit", (code) => {
        clearTimeout(timeout);
        if (this.process === proc) {
          this.process = null;
          this.info = null;
        }
        if (code !== null && code !== 0) {
          reject(new Error(`Anvil exited with code ${code}: ${outputBuffer}`));
        }
      });
    });
  }

  async stopFork(): Promise<{ stopped: boolean }> {
    if (!this.process) {
      return { stopped: false };
    }
    const proc = this.process;
    this.process = null;
    this.info = null;

    return new Promise((resolve) => {
      proc.on("exit", () => resolve({ stopped: true }));
      proc.kill("SIGTERM");
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        resolve({ stopped: true });
      }, 3000);
    });
  }
}
