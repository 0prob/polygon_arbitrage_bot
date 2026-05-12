import type { WatcherEnrichmentTask } from "./watcher_types.ts";

const WATCHER_ENRICHMENT_RETRY_BASE_MS = 30_000;
const WATCHER_ENRICHMENT_RETRY_MAX_MS = 300_000;

export type PendingWatcherEnrichment = {
  dirty: boolean;
  promise: Promise<void>;
  epoch: number;
};

export type WatcherEnrichmentRetryState = {
  attempts: number;
  nextRetryAt: number;
  lastReason: string;
};

export type EpochWatcherEnrichmentTask = (epoch: number) => unknown | Promise<unknown>;

type WatcherEnrichmentCooldownMeta = {
  poolAddress: string;
  retryInMs: number;
  attempts: number;
  lastReason: string;
};

type WatcherEnrichmentRetryMeta = {
  poolAddress: string;
  attempts: number;
  cooldownMs: number;
  error: string;
};

type EnqueueWatcherEnrichmentOptions = {
  pending: Map<string, PendingWatcherEnrichment>;
  retryState: Map<string, WatcherEnrichmentRetryState>;
  addr: unknown;
  taskFn: EpochWatcherEnrichmentTask | WatcherEnrichmentTask;
  epoch: number;
  isClosed: () => boolean;
  isCurrentEpoch: (epoch: number) => boolean;
  onCooldown?: (meta: WatcherEnrichmentCooldownMeta) => void;
  onRetry?: (meta: WatcherEnrichmentRetryMeta) => void;
};

function normalizeEnrichmentAddress(addr: unknown) {
  return String(addr ?? "").toLowerCase();
}

function enrichmentErrorMessage(error: unknown) {
  return String((error as { message?: unknown } | null | undefined)?.message ?? error ?? "unknown enrichment error");
}

export function clearWatcherEnrichmentRetry(
  retryState: Map<string, WatcherEnrichmentRetryState>,
  addr: string,
) {
  retryState.delete(addr);
}

export function recordWatcherEnrichmentRetry(
  retryState: Map<string, WatcherEnrichmentRetryState>,
  addr: string,
  error: unknown,
  now = Date.now(),
): WatcherEnrichmentRetryMeta {
  const current = retryState.get(addr);
  const attempts = (current?.attempts ?? 0) + 1;
  const cooldownMs = Math.min(
    WATCHER_ENRICHMENT_RETRY_BASE_MS * Math.max(1, 2 ** (attempts - 1)),
    WATCHER_ENRICHMENT_RETRY_MAX_MS,
  );
  const lastReason = enrichmentErrorMessage(error);
  retryState.set(addr, {
    attempts,
    nextRetryAt: now + cooldownMs,
    lastReason,
  });
  return {
    poolAddress: addr,
    attempts,
    cooldownMs,
    error: lastReason,
  };
}

export function clearPendingWatcherEnrichment(
  pending: Map<string, PendingWatcherEnrichment>,
) {
  const cleared = pending.size;
  pending.clear();
  return cleared;
}

export function enqueueWatcherEnrichment({
  pending,
  retryState,
  addr,
  taskFn,
  epoch,
  isClosed,
  isCurrentEpoch,
  onCooldown,
  onRetry,
}: EnqueueWatcherEnrichmentOptions) {
  if (isClosed()) return Promise.resolve();
  const normalizedAddr = normalizeEnrichmentAddress(addr);
  const retry = retryState.get(normalizedAddr);
  const now = Date.now();
  if (retry && retry.nextRetryAt > now) {
    onCooldown?.({
      poolAddress: normalizedAddr,
      retryInMs: retry.nextRetryAt - now,
      attempts: retry.attempts,
      lastReason: retry.lastReason,
    });
    return Promise.resolve();
  }

  const pendingEntry = pending.get(normalizedAddr);
  if (pendingEntry) {
    pendingEntry.dirty = true;
    return pendingEntry.promise;
  }

  const entry: PendingWatcherEnrichment = {
    dirty: false,
    promise: Promise.resolve(),
    epoch,
  };
  entry.promise = (async () => {
    try {
      do {
        entry.dirty = false;
        if (isClosed() || !isCurrentEpoch(entry.epoch)) break;
        await taskFn(entry.epoch);
        clearWatcherEnrichmentRetry(retryState, normalizedAddr);
      } while (entry.dirty && !isClosed() && isCurrentEpoch(entry.epoch));
    } catch (err) {
      onRetry?.(recordWatcherEnrichmentRetry(retryState, normalizedAddr, err));
    } finally {
      if (pending.get(normalizedAddr) === entry) {
        pending.delete(normalizedAddr);
      }
    }
  })();

  pending.set(normalizedAddr, entry);
  return entry.promise;
}
