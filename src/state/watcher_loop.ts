import type { HyperSyncRawLog } from "../hypersync/logs.ts";
import { handleWatcherRollbackGuard, type WatcherRollbackRegistry } from "./watcher_reorg.ts";
import { commitWatcherProgressCheckpoint, type WatcherProgressRegistry, watcherProgressShouldLog } from "./watcher_progress.ts";
import { watcherProgressMeta, watcherReorgMeta } from "./watcher_poll_utils.ts";
import type { WatcherPollErrorTracker } from "./watcher_poll_errors.ts";
import type { WatcherPollResponse } from "./watcher_shards.ts";
import { recordWatcherPollTelemetry } from "../utils/metrics.ts";
import { calculateAdaptiveSleepMs } from "./watcher_height_wait.ts";

export type WatcherLoopRegistry = WatcherRollbackRegistry & WatcherProgressRegistry;

export type WatcherLoopLogger = {
  info: (meta: unknown, message: string) => unknown;
  warn: (meta: unknown, message: string) => unknown;
};

export type WatcherLoopRunnerLogger = WatcherLoopLogger & {
  error: (meta: unknown, message: string) => unknown;
};

export type WatcherPollResponseHandlerOptions = {
  response: WatcherPollResponse;
  registry: WatcherLoopRegistry;
  checkpointKey: string;
  currentLastBlock: number;
  idleSleepMs: number;
  handleLogs: (logs: HyperSyncRawLog[]) => Set<string> | Promise<Set<string>>;
  reloadCacheFromRegistry: () => Set<string>;
  advanceEnrichmentEpoch: () => unknown;
  waitForHeightAdvance: (targetNextBlock: unknown, knownArchiveHeight: unknown) => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
  onBatch?: ((batch: unknown) => void) | null;
  onReorg?: ((reorg: unknown) => void) | null;
  logger: WatcherLoopLogger;
};

export type WatcherPollResponseHandlerResult = {
  lastBlock: number;
  reorgDetected: boolean;
  changedAddrs: Set<string>;
  progress?: ReturnType<typeof watcherProgressMeta>;
};

export type WatcherLoopRunnerOptions = {
  isRunning: () => boolean;
  stopForHalt: () => void;
  getLastBlock: () => number;
  setLastBlock: (block: number) => void;
  pollOnce: () => Promise<WatcherPollResponse | null>;
  handlePollResponse: (response: WatcherPollResponse) => Promise<WatcherPollResponseHandlerResult>;
  pollErrors: WatcherPollErrorTracker;
  sleep: (ms: number) => Promise<unknown>;
  wakeSleep: () => void;
  onHalt?: ((event: Record<string, unknown>) => void) | null;
  logger: WatcherLoopRunnerLogger;
};

export async function runWatcherLoop({
  isRunning,
  stopForHalt,
  getLastBlock,
  setLastBlock,
  pollOnce,
  handlePollResponse,
  pollErrors,
  sleep,
  wakeSleep,
  onHalt,
  logger,
}: WatcherLoopRunnerOptions) {
  while (isRunning()) {
    try {
      const res = await pollOnce();
      if (!res) break;
      if (!isRunning()) break;
      const recoveryMeta = pollErrors.recoveryMeta(getLastBlock() + 1);
      if (recoveryMeta) {
        logger.info(recoveryMeta, "Watcher poll recovered after errors");
        pollErrors.markRecovered();
      }

      const handled = await handlePollResponse(res);
      setLastBlock(handled.lastBlock);
      if (handled.reorgDetected) {
        await sleep(500);
        continue;
      }
    } catch (err) {
      if (!isRunning()) break;
      const pollError = pollErrors.resolve(err, getLastBlock());
      logger.error(pollError.errorLogMeta, pollError.errorLogMessage);
      if (pollError.haltMeta) {
        logger.error(pollError.haltMeta, "Watcher halted after repeated integrity failures");
        stopForHalt();
        onHalt?.(pollError.haltMeta);
        wakeSleep();
        break;
      }
      await sleep(pollError.backoffMs);
    }
  }
}

export async function handleWatcherPollResponse({
  response,
  registry,
  checkpointKey,
  currentLastBlock,
  idleSleepMs,
  handleLogs,
  reloadCacheFromRegistry,
  advanceEnrichmentEpoch,
  waitForHeightAdvance,
  sleep,
  onBatch,
  onReorg,
  logger,
}: WatcherPollResponseHandlerOptions): Promise<WatcherPollResponseHandlerResult> {
  if (response.rollbackGuard) {
    const rollback = handleWatcherRollbackGuard({
      registry,
      checkpointKey,
      rollbackGuard: response.rollbackGuard,
      beforeRollback: ({ reorgBlock }) => {
        logger.warn({ reorgBlock }, "Reorg detected; rolling back registry state");
        advanceEnrichmentEpoch();
      },
    });
    if (rollback.reorgDetected) {
      const changedAddrs = reloadCacheFromRegistry();
      logger.warn(
        watcherReorgMeta(rollback.reorgBlock, rollback.rollbackResult, changedAddrs, rollback.checkpointBlock),
        "Watcher reorg rollback summary",
      );
      onReorg?.({
        reorgBlock: rollback.reorgBlock,
        changedAddrs,
      });
      return {
        lastBlock: rollback.checkpointBlock,
        reorgDetected: true,
        changedAddrs,
      };
    }
  }

  const logs = response.data?.logs ?? [];
  const handleStartedAt = Date.now();
  const changedAddrs = logs.length > 0 ? await handleLogs(logs) : new Set<string>();
  const handleElapsedMs = Date.now() - handleStartedAt;
  const progress = watcherProgressMeta(
    response.nextBlock,
    currentLastBlock,
    response.archiveHeight,
    logs.length,
    response.shardSummary ?? null,
  );
  const pollLagBlocks = progress.archiveHeight != null ? Math.max(0, progress.archiveHeight - progress.checkpointBlock) : null;
  const logsPerSec = logs.length > 0 ? logs.length / Math.max(0.001, handleElapsedMs / 1000) : 0;
  Object.assign(progress, {
    pollLagBlocks,
    logsPerSec,
    logProcessMs: handleElapsedMs,
  });
  recordWatcherPollTelemetry({
    pollLagBlocks,
    logsPerSec,
  });
  const commitStartedAt = Date.now();
  const progressCommit = commitWatcherProgressCheckpoint({
    registry,
    checkpointKey,
    currentLastBlock,
    progress,
    rollbackGuard: response.rollbackGuard ?? null,
  });
  Object.assign(progress, {
    checkpointCommitMs: Date.now() - commitStartedAt,
  });
  const lastBlock = progressCommit.lastBlock;

  if (onBatch && changedAddrs.size > 0) {
    onBatch(changedAddrs);
  }

  if (watcherProgressShouldLog(progress)) {
    logger.info(progress, "Watcher poll progress");
  }

  if (logs.length === 0 || progress.caughtUp) {
    if (progress.caughtUp) {
      await waitForHeightAdvance(progress.nextBlock, progress.archiveHeight);
    } else {
      // Use adaptive sleep based on poll lag for smarter idle timing
      const adaptiveSleep = calculateAdaptiveSleepMs(progress.pollLagBlocks ?? null, idleSleepMs);
      await sleep(adaptiveSleep);
    }
  }

  return {
    lastBlock,
    reorgDetected: false,
    changedAddrs,
    progress,
  };
}
