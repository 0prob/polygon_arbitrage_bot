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

  // Simple rate tracking (blocks per second over recent samples)
  private readonly blockSamples: { time: number; block: number }[] = [];
  private readonly MAX_SAMPLES = 20;

  constructor(private opts: HyperIndexMonitorOptions) {
    this.proc = createHyperIndexProcess(opts.processOptions);
    this.checkIntervalMs = opts.checkIntervalMs ?? 10_000;
    this.maxStallMs = opts.maxStallMs ?? 30_000;
    this.maxLagBlocks = opts.maxLagBlocks ?? 200;
  }

  /** Tracks whether we started the HyperIndex process ourselves. If false, an external envio is managing it. */
  private _managingProcess = false;
  /** Guard against concurrent restart attempts triggered by overlapping checkHealth() ticks. */
  private _restarting = false;

  async prepare(): Promise<void> {
    // Check if Hasura is already running before starting our own process.
    // This allows users to run `bun dev` (envio) separately while the bot connects to it.
    const hasuraUrl = this.opts.processOptions.hasuraUrl;
    if (hasuraUrl) {
      try {
        const baseUrl = hasuraUrl.replace(/\/v1\/graphql\/?$/, "");
        const res = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          this.opts.logger.info("Hasura already running — skipping HyperIndex process management (bot will connect to existing instance)");
          this._isHealthy = true;
          this._managingProcess = false;
          return;
        }
      } catch {
        // Hasura not reachable, proceed to start our own process
      }
    }

    try {
      await this.proc.start();
      this._isHealthy = true;
      this._managingProcess = true;
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
    // Only stop the process if we started it (don't kill externally-managed envio)
    if (this._managingProcess) {
      try {
        await this.proc.stop();
      } catch {
        // best effort
      }
    }
  }

  isHealthy(): boolean {
    return this._isHealthy;
  }

  isRunning(): boolean {
    // When externally managed (user runs `bun dev` separately), always report as running
    if (!this._managingProcess) return true;
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
    // Prevent re-entrant calls: if a restart is already in progress (from a prior tick),
    // skip this tick entirely. This is the root cause of the "Hasura unreachable restart storm"
    // where multiple concurrent checkHealth ticks each trigger restart() simultaneously.
    if (this._restarting) return;

    // When externally managed (user runs `bun dev` separately), skip process management
    if (this._managingProcess) {
      if (!this.proc.isRunning()) {
        this._isHealthy = false;
        this.opts.logger.warn({ attempts: this.restartAttempts }, "HyperIndex not running, attempting restart");
        await this.restart();
        return;
      }
    }

    // Try to get real chain head for accurate lag (prefer official HyperSync client)
    if (this.opts.hyperSync) {
      try {
        await this.opts.hyperSync.waitForRateLimit();
        const head = await this.opts.hyperSync.getHeight();
        if (head > this.lastChainHead) this.lastChainHead = head;

        // === SURFACE RATE LIMIT STATE ===
        // With paid 200 rpm plan, rate limits are transient. Log for observability.
        const rl = this.opts.hyperSync.rateLimitInfo?.();
        if (rl && rl.remaining !== undefined && rl.remaining < 10) {
          this.opts.logger.warn({ rateLimitInfo: rl }, "HyperSync rate-limited — paid plan should recover within the rate window");
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
    // When externally managed, just warn instead of restarting.
    if (this.opts.processOptions.hasuraUrl) {
      try {
        const url = new URL(this.opts.processOptions.hasuraUrl);
        const healthUrl = `${url.protocol}//${url.host}/healthz`;
        const res = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`Hasura health check returned ${res.status}`);
      } catch (err) {
        if (this._managingProcess) {
          this.opts.logger.error({ err, url: this.opts.processOptions.hasuraUrl }, "Hasura unreachable — forcing HyperIndex restart");
          this._isHealthy = false;
          await this.restart();
          return;
        }
        this.opts.logger.warn({ err, url: this.opts.processOptions.hasuraUrl }, "Hasura unreachable (externally managed)");
        this._isHealthy = false;
        return;
      }
    }

    // Surface rate limit info (useful for autonomous debugging of 200 req/min issues)
    if (this.opts.hyperSync) {
      try {
        const rl = this.opts.hyperSync.rateLimitInfo?.();
        if (rl && this._managingProcess) {
          this.opts.logger.debug({ rateLimitInfo: rl, lag }, "HyperIndex monitor - current HyperSync rate limit state");
        }
      } catch {}
    }

    if (current > 0) {
      if (current > this.lastSyncedBlock) {
        this.lastSyncedBlock = current;
        this.lastProgressTime = Date.now();
        this.recordBlockSample(current);
      } else if (this._managingProcess && Date.now() - this.lastProgressTime > this.maxStallMs) {
        // Before declaring a stall, check if HyperSync rate limits are exhausted.
        // HyperIndex may be legitimately waiting 41-45s for the next rate-limit window.
        // In that case, extend the stall threshold rather than restarting into the same exhausted key.
        //
        // Two sources of rate-limit truth (checked in order of reliability):
        //   1. getProcessRateLimitInfo() — parsed from HyperIndex stdout ("resets_in=41s").
        //      This is the authoritative signal: the child process knows its own rate-limit state.
        //   2. this.opts.hyperSync?.rateLimitInfo?.() — from the SDK client.
        //      Useful when the SDK is making direct HyperSync calls, but may be null/stale
        //      relative to what the child process is experiencing.
        const procRl = this.proc.getProcessRateLimitInfo?.();
        const sdkRl = this.opts.hyperSync?.rateLimitInfo?.();

        // Determine reset deadline from whichever source has data, preferring process stdout
        let rateLimitResetAt: number | undefined;
        if (procRl) {
          rateLimitResetAt = procRl.resetAt;
        } else if (sdkRl && sdkRl.remaining !== undefined && sdkRl.remaining < 5) {
          const resetsIn = sdkRl.resetsIn ?? 45;
          rateLimitResetAt = Date.now() + resetsIn * 1000 + 5_000;
        }

        const isRateLimited = rateLimitResetAt !== undefined && Date.now() < rateLimitResetAt;
        if (isRateLimited) {
          const remainingMs = rateLimitResetAt! - Date.now();
          this.opts.logger.debug(
            { stallMs: Date.now() - this.lastProgressTime, rateLimitResetAt, remainingMs, procRl, sdkRl },
            "HyperIndex not progressing but known to be rate-limited — extending stall threshold instead of restarting",
          );
          return;
        }

        // Not rate-limited — genuine stall
        const rl = procRl ?? sdkRl;
        this.opts.logger.error(
          {
            lastSynced: this.lastSyncedBlock,
            stallMs: Date.now() - this.lastProgressTime,
            lag,
            maxStallMs: this.maxStallMs,
            ...(rl ? { rateLimitInfo: rl } : {}),
          },
          "HyperIndex sync STALLED — no progress for a long time. Forcing restart. (Check pipeline split, rate limits, RPC quality, and batch size in hyperindex/config.yaml)",
        );
        this._isHealthy = false;
        await this.restart();
        return;
      }
    }

    // Lag-based health check (only restart if we manage the process)
    if (lag > this.maxLagBlocks && this.lastSyncedBlock > 0) {
      this.opts.logger.warn(
        { lag, maxLag: this.maxLagBlocks, synced: this.lastSyncedBlock, head: this.lastChainHead },
        "HyperIndex significantly behind chain head",
      );
      if (this._managingProcess && lag > this.maxLagBlocks * 2) {
        // Don't restart for lag if we're heavily rate-limited — the restart would pick
        // the same exhausted token and make no progress, but we'd lose the existing
        // rate-limit wait progress.
        const rl = this.opts.hyperSync?.rateLimitInfo?.();
        if (rl && rl.remaining !== undefined && rl.remaining < 5) {
          this.opts.logger.warn(
            { lag, rateLimitInfo: rl },
            "Skip lag-based restart — HyperIndex is rate-limited, restart would hit same exhausted token",
          );
        } else {
          this._isHealthy = false;
          await this.restart();
          return;
        }
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

      // Surface rate limit info from the official client when available (very useful for 200 req/min diagnosis)
      if (this.opts.hyperSync) {
        try {
          const rl = this.opts.hyperSync.rateLimitInfo?.();
          if (rl) extra.rateLimitInfo = rl;
        } catch {}
      }

      this.opts.logger.debug(extra, "HyperIndex sync status (instrumented trace)");

      if (lag > 200) {
        this.opts.logger.warn(
          { lag, synced: this.lastSyncedBlock },
          "HyperIndex significantly behind — possible bottleneck (rate limit / effects / DB / batch size)",
        );
      }
    }
  }

  getLastStatus(): {
    status: string;
    synced: number;
    remote: number;
    lag: number;
    syncRate: number;
    envioKeyPrefix?: string;
  } {
    const lag = this.getCurrentLag();
    const keyPrefix = this.proc.getCurrentEnvioKeyPrefix?.();
    return {
      status: this._isHealthy ? "running" : "error",
      synced: this.lastSyncedBlock,
      remote: this.lastRemoteBlock || this.lastChainHead,
      lag,
      syncRate: this.getSyncRate(),
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
    this._restarting = true;
    this._isHealthy = false;
    try {
      await this.proc.stop();
    } catch (_: unknown) {
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
    } finally {
      this._restarting = false;
    }
  }
}
