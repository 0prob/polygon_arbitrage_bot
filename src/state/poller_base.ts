import type { RouteState, RouteStateCache } from "../routing/simulation_types.ts";

export type BatchFetchResult<TNormalized = unknown> = {
  addr: string;
  normalized: TNormalized | null | undefined;
  error: unknown;
};

type BatchFetchSuccess<TNormalized> = {
  addr: string;
  normalized: TNormalized;
  error: unknown;
};

export type PollerBaseOptions = {
  verbose?: boolean;
};

export type StatePollerOptions = PollerBaseOptions & {
  concurrency?: number;
};

export type ProtocolPoolRecord = {
  pool_address: string;
  protocol?: unknown;
  tokens?: unknown;
  metadata?: unknown;
  [key: string]: unknown;
};

export type TokenDecimalsRegistry = {
  getActivePoolsMeta: () => ProtocolPoolRecord[];
  getTokenDecimals: (tokens: string[]) => Map<string, number>;
};

export abstract class TimedPoller {
  protected _verbose: boolean;
  protected _timer: ReturnType<typeof setTimeout> | null;
  protected _running: boolean;
  protected _passCount: number;
  protected _loopPromise: Promise<void> | null;
  protected _loopToken: number;

  constructor(options: PollerBaseOptions = {}) {
    this._verbose = options.verbose ?? false;
    this._timer = null;
    this._running = false;
    this._passCount = 0;
    this._loopPromise = null;
    this._loopToken = 0;
  }

  protected _completePass(label: string, startedAt: number, updated: number, failed: number) {
    const durationMs = Date.now() - startedAt;
    this._passCount++;
    console.log(`[${label}] Pass #${this._passCount}: ${updated} updated, ${failed} failed (${durationMs}ms)`);
    return { updated, failed, durationMs };
  }

  protected _storeBatchResults<TNormalized>(
    label: string,
    cache: Map<string, TNormalized>,
    results: BatchFetchResult<TNormalized>[],
    onVerboseSuccess?: (entry: BatchFetchSuccess<TNormalized>) => string,
  ) {
    let updated = 0;
    let failed = 0;

    for (const entry of results) {
      if (entry.normalized != null) {
        const successEntry = {
          addr: entry.addr,
          normalized: entry.normalized,
          error: entry.error,
        };
        cache.set(entry.addr, successEntry.normalized);
        updated++;
        if (this._verbose && onVerboseSuccess) {
          console.log(onVerboseSuccess(successEntry));
        }
        continue;
      }

      failed++;
      if (this._verbose) {
        console.warn(`[${label}] Failed ${entry.addr}: ${entry.error instanceof Error ? entry.error.message : entry.error}`);
      }
    }

    return { updated, failed };
  }

  protected _startLoop(label: string, intervalMs: number, poll: () => Promise<unknown>) {
    if (this._running) return this._loopPromise;
    this._running = true;
    const loopToken = ++this._loopToken;

    const loop = async () => {
      try {
        while (this._running && this._loopToken === loopToken) {
          try {
            await poll();
          } catch (err: unknown) {
            console.error(`[${label}] Poll error: ${err instanceof Error ? err.message : err}`);
          }
          if (!this._running || this._loopToken !== loopToken) break;
          await new Promise<void>((resolve) => {
            this._timer = setTimeout(() => {
              this._timer = null;
              resolve();
            }, intervalMs);
          });
        }
      } finally {
        if (this._loopToken === loopToken) {
          this._running = false;
        }
        if (this._loopPromise === loopPromise) {
          this._loopPromise = null;
        }
      }
    };

    const loopPromise = loop();
    this._loopPromise = loopPromise;
    return loopPromise;
  }

  async stop() {
    const activeLoop = this._loopPromise;
    this._running = false;
    this._loopToken++;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    await activeLoop?.catch(() => {});
  }

  get isRunning() {
    return this._running;
  }
}

export function asBatchResult<TNormalized = RouteState>(
  addr: string,
  normalized: TNormalized | null,
  error: unknown = null,
): BatchFetchResult<TNormalized> {
  return { addr, normalized, error };
}

export type { RouteState, RouteStateCache };
