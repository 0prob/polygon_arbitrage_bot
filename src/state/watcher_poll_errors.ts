import {
  classifyWatcherPollError,
  WATCHER_MAX_CONSECUTIVE_INTEGRITY_ERRORS,
  watcherErrorBackoffMeta,
  watcherErrorBackoffMs,
  watcherHaltMeta,
  watcherShouldHaltAfterIntegrityError,
  type WatcherErrorCategory,
} from "./watcher_poll_utils.ts";

export type ResolveWatcherPollErrorOptions = {
  error: unknown;
  consecutivePollErrors: number;
  consecutiveIntegrityPollErrors: number;
  lastBlock: number;
};

export type WatcherPollErrorResolution = {
  errorCategory: WatcherErrorCategory;
  consecutivePollErrors: number;
  consecutiveIntegrityPollErrors: number;
  backoffMs: number;
  errorLogMeta: Record<string, unknown>;
  errorLogMessage: "Watcher integrity error" | "HyperSync poll error";
  haltMeta: Record<string, unknown> | null;
};

export function resolveWatcherPollError({
  error,
  consecutivePollErrors,
  consecutiveIntegrityPollErrors,
  lastBlock,
}: ResolveWatcherPollErrorOptions): WatcherPollErrorResolution {
  const nextConsecutivePollErrors = consecutivePollErrors + 1;
  const errorCategory = classifyWatcherPollError(error);
  const nextConsecutiveIntegrityPollErrors = errorCategory === "integrity" ? consecutiveIntegrityPollErrors + 1 : 0;
  const backoffMs = watcherErrorBackoffMs(error, nextConsecutivePollErrors);
  const haltMeta =
    errorCategory === "integrity" && watcherShouldHaltAfterIntegrityError(nextConsecutiveIntegrityPollErrors)
      ? watcherHaltMeta(error, nextConsecutiveIntegrityPollErrors, WATCHER_MAX_CONSECUTIVE_INTEGRITY_ERRORS, lastBlock)
      : null;

  return {
    errorCategory,
    consecutivePollErrors: nextConsecutivePollErrors,
    consecutiveIntegrityPollErrors: nextConsecutiveIntegrityPollErrors,
    backoffMs,
    errorLogMeta: {
      ...watcherErrorBackoffMeta(error, nextConsecutivePollErrors, backoffMs, lastBlock, errorCategory),
      consecutiveIntegrityPollErrors: nextConsecutiveIntegrityPollErrors,
    },
    errorLogMessage: errorCategory === "integrity" ? "Watcher integrity error" : "HyperSync poll error",
    haltMeta,
  };
}

export type WatcherPollRecoveryMeta = {
  consecutivePollErrors: number;
  consecutiveIntegrityPollErrors: number;
  resumedFromBlock: number;
};

export class WatcherPollErrorTracker {
  private _consecutivePollErrors = 0;
  private _consecutiveIntegrityPollErrors = 0;
  private _haltMeta: Record<string, unknown> | null = null;

  get haltMeta() {
    return this._haltMeta;
  }

  reset() {
    this._consecutivePollErrors = 0;
    this._consecutiveIntegrityPollErrors = 0;
    this._haltMeta = null;
  }

  recoveryMeta(resumedFromBlock: number): WatcherPollRecoveryMeta | null {
    if (this._consecutivePollErrors <= 0) return null;
    return {
      consecutivePollErrors: this._consecutivePollErrors,
      consecutiveIntegrityPollErrors: this._consecutiveIntegrityPollErrors,
      resumedFromBlock,
    };
  }

  markRecovered() {
    this._consecutivePollErrors = 0;
    this._consecutiveIntegrityPollErrors = 0;
    this._haltMeta = null;
  }

  resolve(error: unknown, lastBlock: number) {
    const resolution = resolveWatcherPollError({
      error,
      consecutivePollErrors: this._consecutivePollErrors,
      consecutiveIntegrityPollErrors: this._consecutiveIntegrityPollErrors,
      lastBlock,
    });
    this._consecutivePollErrors = resolution.consecutivePollErrors;
    this._consecutiveIntegrityPollErrors = resolution.consecutiveIntegrityPollErrors;
    if (resolution.haltMeta) {
      this._haltMeta = resolution.haltMeta;
    }
    return resolution;
  }
}
