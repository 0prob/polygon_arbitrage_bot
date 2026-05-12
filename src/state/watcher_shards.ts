import type { HyperSyncGetResponse } from "../hypersync/query_policy.ts";
import type { HyperSyncRawLog } from "../hypersync/logs.ts";
import {
  compareRollbackGuards,
  dedupeWatcherLogs,
  mergeRollbackGuards,
  parseOptionalWatcherBlock,
  parseWatcherBlock,
  sortWatcherLogs,
  type RollbackGuard,
  type WatcherShardSummary,
  watcherLogIsBeforeNextBlock,
  watcherShardArchiveHeightMeta,
  watcherShardFailureError,
} from "./watcher_poll_utils.ts";

export type WatcherPollResponse = Omit<
  HyperSyncGetResponse<HyperSyncRawLog>,
  "archiveHeight" | "data" | "nextBlock" | "rollbackGuard"
> & {
  rollbackGuard?: RollbackGuard | null;
  data: {
    logs: HyperSyncRawLog[];
  };
  nextBlock: number | null;
  archiveHeight: number | null;
  shardSummary: WatcherShardSummary;
};

export type WatcherShardMergeResult = WatcherPollResponse & {
  archiveHeightMeta: ReturnType<typeof watcherShardArchiveHeightMeta> | null;
};

export function mergeWatcherShardSettledResults(
  settled: PromiseSettledResult<HyperSyncGetResponse<HyperSyncRawLog>>[],
): WatcherShardMergeResult {
  const failures: Array<{ shardIndex: number; reason: unknown }> = [];
  const responses: HyperSyncGetResponse<HyperSyncRawLog>[] = [];

  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (result.status === "rejected") {
      failures.push({ shardIndex: i, reason: result.reason });
    } else {
      responses.push(result.value);
    }
  }

  if (failures.length > 0) {
    throw watcherShardFailureError(failures);
  }

  return mergeWatcherShardResponses(responses);
}

export function mergeWatcherShardResponses(
  responses: HyperSyncGetResponse<HyperSyncRawLog>[],
): WatcherShardMergeResult {
  const logs: HyperSyncRawLog[] = [];
  let rollbackGuard: RollbackGuard | null = null;
  let nextBlock = Number.POSITIVE_INFINITY;
  let archiveHeight = Number.POSITIVE_INFINITY;
  const shardArchiveHeights = new Set<number>();

  const responseMeta = responses.map((res) => {
    let shardNextBlock;
    try {
      shardNextBlock = parseWatcherBlock("shard nextBlock cursor", res.nextBlock);
    } catch {
      throw new Error("Watcher shard response did not include a finite nextBlock cursor; cannot merge incomplete shard metadata.");
    }
    nextBlock = Math.min(nextBlock, shardNextBlock);

    const shardArchiveHeight = parseOptionalWatcherBlock("shard archiveHeight", res.archiveHeight);
    if (shardArchiveHeight != null) {
      archiveHeight = Math.min(archiveHeight, shardArchiveHeight);
      shardArchiveHeights.add(shardArchiveHeight);
    }
    return { res };
  });

  const mergedNextBlock = Number.isFinite(nextBlock) ? nextBlock : null;

  for (const { res } of responseMeta) {
    if (res.rollbackGuard) {
      if (!rollbackGuard) {
        rollbackGuard = res.rollbackGuard;
      } else if (!compareRollbackGuards(rollbackGuard, res.rollbackGuard)) {
        throw new Error("Watcher shard responses returned mismatched rollback guards; refusing to merge inconsistent chain views.");
      } else {
        rollbackGuard = mergeRollbackGuards(rollbackGuard, res.rollbackGuard);
      }
    }

    if (Array.isArray(res.data?.logs) && res.data.logs.length > 0) {
      logs.push(...res.data.logs.filter((log) => watcherLogIsBeforeNextBlock(log, mergedNextBlock)));
    }
  }

  const archiveHeightMeta = shardArchiveHeights.size > 1
    ? watcherShardArchiveHeightMeta(shardArchiveHeights)
    : null;

  return {
    rollbackGuard,
    data: { logs: dedupeWatcherLogs(sortWatcherLogs(logs)) },
    nextBlock: Number.isFinite(nextBlock) ? nextBlock : null,
    archiveHeight: Number.isFinite(archiveHeight) ? archiveHeight : null,
    shardSummary: {
      archiveHeights: [...shardArchiveHeights].sort((a, b) => a - b),
    },
    archiveHeightMeta,
  };
}
