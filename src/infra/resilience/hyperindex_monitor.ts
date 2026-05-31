import type { Lifecycle } from "../../orchestrator/lifecycle.ts";
import type { HyperIndexProcessOptions } from "../hypersync/hyperindex_process.ts";
import { createHyperIndexProcess, type HyperIndexProcess } from "../hypersync/hyperindex_process.ts";
import type { Logger } from "../observability/logger.ts";
import type { HyperSyncService } from "../hypersync/hypersync_service.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface HyperIndexMonitorOptions {
  processOptions: HyperIndexProcessOptions;
  checkIntervalMs?: number;
  maxStallMs?: number;
  maxLagBlocks?: number; // If lag > this, consider unhealthy (e.g. 200)
  logger: Logger;
  /** Optional function to fetch current chain head. Enables real lag calculation. */
  getChainHead?: () => Promise<number>;
  /** Preferred: Official HyperSync client for reliable height + future queries (replaces log scraping reliance) */
  hyperSync?: HyperSyncService;
}

export class HyperIndexMonitor implements Lifecycle {
  private proc: HyperIndexProcess;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private _isHealthy = false;
  private restartAttempts = 0;
  private readonly checkIntervalMs: number;
  private readonly maxStallMs: number;
  private readonly maxLagBlocks: number;
  private lastSyncedBlock = 0;
  private lastProgressTime = Date.now();
  private lastRemoteBlock = 0;
  private lastChainHead = 0;

  // Rate limit pain detector — when we see a lot of quota pain, we want to cycle
  // to the next ENVIO_API_TOKEN in the pool (via restart) faster than a full stall.
  private rateLimitPainCount = 0;
  private lastRateLimitPain = 0;

  // Simple rate tracking (blocks per second over recent samples)
  private readonly blockSamples: { time: number; block: number }[] = [];
  private readonly MAX_SAMPLES = 20;

  constructor(private opts: HyperIndexMonitorOptions) {
    this.proc = createHyperIndexProcess(opts.processOptions);
    this.checkIntervalMs = opts.checkIntervalMs ?? 10_000;
    this.maxStallMs = opts.maxStallMs ?? 30_000;
    this.maxLagBlocks = opts.maxLagBlocks ?? 200;
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
    } catch (_err: unknown) {
      // best effort
    }
  }

  isHealthy(): boolean {
    return this._isHealthy;
  }

  isRunning(): boolean {
    return this.proc.isRunning();
  }

  /** Allows wiring a chain head fetcher after the monitor is constructed (used by CLI) */
  setChainHeadFetcher(fn: () => Promise<number>): void {
    this.opts.getChainHead = fn;
  }

  /** Inject the official HyperSync service for reliable progress/height (preferred over log scraping) */
  setHyperSyncService(service: HyperSyncService): void {
    this.opts.hyperSync = service;
  }

  /**
   * Optional provider for the actual height the indexer has processed (e.g. from Hasura max(lastUpdatedBlock)).
   * This is the key improvement over pure log scraping for accurate "how far behind" reporting.
   */
  setIndexedHeightProvider(fn: () => Promise<number>): void {
    this._getIndexedHeight = fn;
  }

  private _getIndexedHeight?: () => Promise<number>;

  private async getIndexedHeight(): Promise<number> {
    if (this._getIndexedHeight) {
      try {
        const height = await this._getIndexedHeight();
        if (height > 0) return height;
      } catch {}
    }
    // Fallback to HyperSync height if we have the service (better than pure log scraping)
    if (this.opts.hyperSync) {
      try {
        return await this.opts.hyperSync.getHeight();
      } catch {}
    }
    return this.lastSyncedBlock;
  }

  updateSyncedBlock(block: number, remote?: number): void {
    if (block > this.lastSyncedBlock) {
      this.lastSyncedBlock = block;
      this.lastProgressTime = Date.now();
    }
    if (remote && remote > this.lastRemoteBlock) {
      this.lastRemoteBlock = remote;
    }
  }

  private async checkHealth(): Promise<void> {
    if (!this.proc.isRunning()) {
      this._isHealthy = false;
      this.opts.logger.warn({ attempts: this.restartAttempts }, "HyperIndex not running, attempting restart");
      await this.restart();
      return;
    }

    // Try to get real chain head for accurate lag (prefer official HyperSync client)
    if (this.opts.hyperSync) {
      try {
        await this.opts.hyperSync.waitForRateLimit();
        const head = await this.opts.hyperSync.getHeight();
        if (head > this.lastChainHead) this.lastChainHead = head;

        // === AUTONOMOUS DEBUG: Always surface rate limit state on every tick ===
        // React to rate limiting by temporarily backing off HyperSync calls.
        const rl = this.opts.hyperSync.rateLimitInfo?.();
        if (rl) {
          // Simple reaction: if we're heavily rate limited, skip the next few health ticks for HyperSync calls.
          if (rl.remaining !== undefined && rl.remaining < 5) {
            this.opts.logger.warn(
              { rateLimitInfo: rl },
              "HyperSync heavily rate-limited — temporarily reducing monitor HyperSync activity",
            );
            // We can let the existing waitForRateLimit() in other places handle most of it.
          }

          // If remaining is critically low for a while, treat as "rate limit pain" and
          // force a HyperIndex restart (which will now pick the *next* token from the pool).
          if (rl.remaining !== undefined && rl.remaining <= 2) {
            this.rateLimitPainCount++;
            this.lastRateLimitPain = Date.now();
            if (this.rateLimitPainCount >= 3) {
              this.opts.logger.warn(
                { rateLimitInfo: rl, painCount: this.rateLimitPainCount },
                "Persistent HyperSync rate limit pain — forcing HyperIndex restart to rotate to next ENVIO_API_TOKEN in pool",
              );
              this.rateLimitPainCount = 0;
              await this.restart();
              return;
            }
          } else {
            // Decay the pain counter when we're healthy again
            if (this.rateLimitPainCount > 0 && Date.now() - this.lastRateLimitPain > 60_000) {
              this.rateLimitPainCount = Math.max(0, this.rateLimitPainCount - 1);
            }
          }
        }
      } catch (err) {
        this.opts.logger.debug({ err }, "HyperSyncService getHeight failed for lag calculation");
      }
    } else if (this.opts.getChainHead) {
      try {
        const head = await this.opts.getChainHead();
        if (head > this.lastChainHead) this.lastChainHead = head;
      } catch (err) {
        this.opts.logger.debug({ err }, "Failed to fetch chain head for lag calculation");
      }
    }

    const current = await this.getIndexedHeight();
    const lag = this.getCurrentLag();

    // Hasura health check: if we have a URL but can't reach it, it's a critical failure.
    // This often happens when docker containers get stuck or fail to start properly.
    if (this.opts.processOptions.hasuraUrl) {
      try {
        const url = new URL(this.opts.processOptions.hasuraUrl);
        const healthUrl = `${url.protocol}//${url.host}/healthz`;
        const res = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`Hasura health check returned ${res.status}`);
      } catch (err) {
        this.opts.logger.error({ err, url: this.opts.processOptions.hasuraUrl }, "Hasura unreachable — forcing HyperIndex restart");
        this._isHealthy = false;
        await this.restart();
        return;
      }
    }

    // Surface rate limit info (useful for autonomous debugging of 100 req/min issues)
    if (this.opts.hyperSync) {
      try {
        const rl = this.opts.hyperSync.rateLimitInfo?.();
        if (rl) {
          this.opts.logger.info({ rateLimitInfo: rl, lag }, "HyperIndex monitor - current HyperSync rate limit state");
        }
      } catch {}
    }

    if (current > 0) {
      if (current > this.lastSyncedBlock) {
        this.lastSyncedBlock = current;
        this.lastProgressTime = Date.now();
        this.recordBlockSample(current);
      } else if (Date.now() - this.lastProgressTime > this.maxStallMs) {
        this.opts.logger.error(
          {
            lastSynced: this.lastSyncedBlock,
            stallMs: Date.now() - this.lastProgressTime,
            lag,
            maxStallMs: this.maxStallMs,
          },
          "HyperIndex sync STALLED — no progress for a long time. Forcing restart. (Check pipeline split, rate limits, RPC quality, and batch size in hyperindex/config.yaml)",
        );
        this._isHealthy = false;
        await this.restart();
        return;
      }
    }

    // New: lag-based health check (more reliable than pure time stall)
    if (lag > this.maxLagBlocks && this.lastSyncedBlock > 0) {
      this.opts.logger.warn(
        { lag, maxLag: this.maxLagBlocks, synced: this.lastSyncedBlock, head: this.lastChainHead },
        "HyperIndex significantly behind chain head",
      );
      // We still mark unhealthy only on extreme lag or stall to avoid flapping
      if (lag > this.maxLagBlocks * 2) {
        this._isHealthy = false;
        await this.restart();
        return;
      }
    }

    this._isHealthy = true;
    this.restartAttempts = 0;

    // === INSTRUMENTATION: Detailed periodic tracing for HyperIndex sync bottlenecks ===
    // This runs on every health tick and gives you visibility into the real limiter
    // (HyperSync quota, effect RPCs, DB writes inside the indexer, batch size, etc.).
    if (Math.random() < 0.2) {
      // Slightly more frequent than before for debugging
      const rate = this.getSyncRate();
      const lag = this.getCurrentLag();

      const extra: Record<string, unknown> = {
        synced: this.lastSyncedBlock,
        lag,
        blkPerSec: rate.toFixed(1),
      };

      // Surface rate limit info from the official client when available (very useful for 100 req/min diagnosis)
      if (this.opts.hyperSync) {
        try {
          const rl = this.opts.hyperSync.rateLimitInfo?.();
          if (rl) extra.rateLimitInfo = rl;
        } catch {}
      }

      this.opts.logger.info(extra, "HyperIndex sync status (instrumented trace)");

      if (lag > 200) {
        this.opts.logger.warn(
          { lag, synced: this.lastSyncedBlock },
          "HyperIndex significantly behind — possible bottleneck (rate limit / effects / DB / batch size)",
        );
      }
    }
  }

  // kept for potential internal use / backward compat
  // @ts-expect-error - intentionally unused for now
  private _getLastSyncedBlock(): number {
    return this.lastSyncedBlock;
  }

  getLastStatus(): {
    status: string;
    synced: number;
    remote: number;
    lag: number;
    syncRate: number;
    rateLimitPain?: number;
    envioKeyPrefix?: string;
  } {
    const lag = this.getCurrentLag();
    const keyPrefix = (this.proc as any).getCurrentEnvioKeyPrefix?.();
    return {
      status: this._isHealthy ? "running" : "error",
      synced: this.lastSyncedBlock,
      remote: this.lastRemoteBlock || this.lastChainHead,
      lag,
      syncRate: this.getSyncRate(),
      rateLimitPain: this.rateLimitPainCount,
      envioKeyPrefix: keyPrefix,
    };
  }

  private getCurrentLag(): number {
    const head = Math.max(this.lastChainHead, this.lastRemoteBlock);
    if (head > 0 && this.lastSyncedBlock > 0) {
      return Math.max(0, head - this.lastSyncedBlock);
    }
    // Fallback to log-based remote if we have it
    if (this.lastRemoteBlock > 0 && this.lastSyncedBlock > 0) {
      return Math.max(0, this.lastRemoteBlock - this.lastSyncedBlock);
    }
    return 0;
  }

  private recordBlockSample(block: number): void {
    this.blockSamples.push({ time: Date.now(), block });
    if (this.blockSamples.length > this.MAX_SAMPLES) this.blockSamples.shift();
  }

  /** Returns approximate blocks per second over the recent sample window */
  private getSyncRate(): number {
    if (this.blockSamples.length < 2) return 0;
    const first = this.blockSamples[0];
    const last = this.blockSamples[this.blockSamples.length - 1];
    const deltaBlocks = last.block - first.block;
    const deltaTimeSec = (last.time - first.time) / 1000;
    if (deltaTimeSec <= 0) return 0;
    return deltaBlocks / deltaTimeSec;
  }

  // Called when we receive remote head info (from process logs)
  updateRemoteBlock(block: number): void {
    if (block > this.lastRemoteBlock) {
      this.lastRemoteBlock = block;
    }
  }

  private async restart(): Promise<void> {
    this._isHealthy = false;
    try {
      await this.proc.stop();
    } catch (_err: unknown) {
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
