import type { Lifecycle } from "../../orchestrator/lifecycle.ts";
import type { HyperIndexProcessOptions } from "../hypersync/hyperindex_process.ts";
import { createHyperIndexProcess, type HyperIndexProcess } from "../hypersync/hyperindex_process.ts";
import type { Logger } from "../observability/logger.ts";

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export interface HyperIndexMonitorOptions {
  processOptions: HyperIndexProcessOptions;
  checkIntervalMs?: number;
  maxStallMs?: number;
  logger: Logger;
}

export class HyperIndexMonitor implements Lifecycle {
  private proc: HyperIndexProcess;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private _isHealthy = false;
  private restartAttempts = 0;
  private readonly checkIntervalMs: number;

  constructor(private opts: HyperIndexMonitorOptions) {
    this.proc = createHyperIndexProcess(opts.processOptions);
    this.checkIntervalMs = opts.checkIntervalMs ?? 10_000;
  }

  async prepare(): Promise<void> {
    try {
      await this.proc.start();
      this._isHealthy = true;
      this.restartAttempts = 0;
    } catch (err) {
      this.opts.logger.warn({ err }, "HyperIndex initial start failed, will retry");
      this._isHealthy = false;
    }
  }

  async start(): Promise<void> {
    this.healthTimer = setInterval(() => this.checkHealth(), this.checkIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    try {
      await this.proc.stop();
    } catch {
      // best effort
    }
  }

  isHealthy(): boolean {
    return this._isHealthy;
  }

  isRunning(): boolean {
    return this.proc.isRunning();
  }

  private async checkHealth(): Promise<void> {
    if (!this.proc.isRunning()) {
      this._isHealthy = false;
      this.opts.logger.warn({ attempts: this.restartAttempts }, "HyperIndex not running, attempting restart");
      await this.restart();
      return;
    }
    this._isHealthy = true;
    this.restartAttempts = 0;
  }

  private async restart(): Promise<void> {
    this._isHealthy = false;
    try {
      await this.proc.stop();
    } catch {
      // best effort
    }
    this.restartAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.restartAttempts), 60_000);
    this.opts.logger.info({ delay, attempt: this.restartAttempts }, "HyperIndex restart backoff");
    await sleep(delay);
    try {
      await this.proc.start();
      this._isHealthy = true;
      this.restartAttempts = 0;
      this.opts.logger.info({}, "HyperIndex restarted successfully");
    } catch (err) {
      this.opts.logger.error({ err, attempt: this.restartAttempts }, "HyperIndex restart failed");
    }
  }
}
