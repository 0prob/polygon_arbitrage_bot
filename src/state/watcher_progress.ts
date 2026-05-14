import type { RollbackGuard } from "./watcher_poll_utils.ts";

export type WatcherProgressRegistry = {
  commitWatcherProgress?: (key: string, block: number, rollbackGuard: RollbackGuard | null) => unknown;
  setCheckpoint?: (key: string, block: number) => unknown;
  setRollbackGuard?: (rollbackGuard: RollbackGuard) => unknown;
};

export type WatcherProgressSnapshot = {
  checkpointBlock: number;
  advancedBlocks: number;
  waitReason?: unknown;
  constrainedBySlowestShardArchiveHeight?: unknown;
};

export type CommitWatcherProgressOptions = {
  registry: WatcherProgressRegistry;
  checkpointKey: string;
  currentLastBlock: number;
  progress: WatcherProgressSnapshot;
  rollbackGuard?: RollbackGuard | null;
};

export type CommitWatcherProgressResult = {
  lastBlock: number;
  advanced: boolean;
};

export function commitWatcherProgressCheckpoint({
  registry,
  checkpointKey,
  currentLastBlock,
  progress,
  rollbackGuard = null,
}: CommitWatcherProgressOptions): CommitWatcherProgressResult {
  const checkpointBlock = progress.checkpointBlock;
  if (checkpointBlock <= currentLastBlock) {
    return { lastBlock: currentLastBlock, advanced: false };
  }

  if (registry.commitWatcherProgress) {
    registry.commitWatcherProgress(checkpointKey, checkpointBlock, rollbackGuard ?? null);
  } else {
    registry.setCheckpoint?.(checkpointKey, checkpointBlock);
    if (rollbackGuard) {
      registry.setRollbackGuard?.(rollbackGuard);
    }
  }

  return { lastBlock: checkpointBlock, advanced: true };
}

export function watcherProgressShouldLog(progress: WatcherProgressSnapshot) {
  return progress.advancedBlocks > 0 || progress.waitReason != null || Boolean(progress.constrainedBySlowestShardArchiveHeight);
}
