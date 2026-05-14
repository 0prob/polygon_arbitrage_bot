import type { HyperSyncRawLog } from "../hypersync/logs.ts";
import type { HyperSyncGetResponse, HyperSyncLogQuery } from "../hypersync/query_policy.ts";
import { classifyWatcherPollError, isRollbackGuardMismatchError, watcherShardRetryDelayMs } from "./watcher_poll_utils.ts";
import { mergeWatcherShardSettledResults, type WatcherPollResponse } from "./watcher_shards.ts";

export const WATCHER_SHARD_TRANSIENT_RETRY_ATTEMPTS = 3;
export type { WatcherPollResponse } from "./watcher_shards.ts";

export type WatcherPollGetter = (query: HyperSyncLogQuery) => Promise<HyperSyncGetResponse<HyperSyncRawLog>>;

export type WatcherPollingLogger = {
  warn: (meta: unknown, message: string) => unknown;
  debug: (meta: unknown, message: string) => unknown;
};

export type PollWatcherOnceOptions = {
  queries: HyperSyncLogQuery[];
  getLogs: WatcherPollGetter;
  isRunning: () => boolean;
  sleep: (ms: number) => Promise<unknown>;
  logger: WatcherPollingLogger;
  retryAttempts?: number;
};

export async function pollWatcherOnce({
  queries,
  getLogs,
  isRunning,
  sleep,
  logger,
  retryAttempts = WATCHER_SHARD_TRANSIENT_RETRY_ATTEMPTS,
}: PollWatcherOnceOptions): Promise<WatcherPollResponse | null> {
  // Fix #5: Retry individual failed shards instead of the entire batch.
  // Previously, a single shard failure caused all shards to be re-fetched.
  // Now we track per-shard retry state and only retry failed shards.
  const shardStates = queries.map((query) => ({
    query,
    result: null as HyperSyncGetResponse<HyperSyncRawLog> | null,
    failed: false,
    retries: 0,
  }));

  for (let attempt = 0; attempt < retryAttempts; attempt++) {
    // Fetch only the shards that haven't succeeded yet
    const pendingShards = shardStates.filter((s) => !s.result);
    if (pendingShards.length === 0) break;

    try {
      const settled = await Promise.allSettled(pendingShards.map((s) => getLogs(s.query)));
      if (!isRunning()) return null;

      // Process results and mark failures for retry
      for (let i = 0; i < settled.length; i++) {
        const shard = pendingShards[i];
        const result = settled[i];
        if (result.status === "fulfilled") {
          shard.result = result.value;
          shard.failed = false;
        } else {
          shard.failed = true;
          shard.retries++;
          const error = result.reason;
          if (!isRollbackGuardMismatchError(error) && classifyWatcherPollError(error) !== "transient") {
            throw error;
          }
        }
      }

      // If all shards succeeded, we're done
      if (shardStates.every((s) => s.result)) break;

      // Check if we should retry
      const failedShards = shardStates.filter((s) => s.failed && s.retries < retryAttempts);
      if (failedShards.length === 0) break;
      if (!isRunning()) return null;

      await sleep(watcherShardRetryDelayMs(attempt));
    } catch (error) {
      if (
        (!isRollbackGuardMismatchError(error) && classifyWatcherPollError(error) !== "transient") ||
        attempt + 1 >= retryAttempts ||
        !isRunning()
      ) {
        throw error;
      }
      await sleep(watcherShardRetryDelayMs(attempt));
    }
  }

  // Merge results from all shards
  const results = shardStates.filter((s) => s.result !== null).map((s) => s.result!);

  if (results.length === 0) {
    throw new Error("All watcher shard queries failed after retries");
  }

  const settled = results.map((r) => ({ status: "fulfilled" as const, value: r }));
  const merged = mergeWatcherShardSettledResults(settled);
  if (merged.archiveHeightMeta) {
    logger[merged.archiveHeightMeta.logLevel](
      merged.archiveHeightMeta,
      "Watcher shard responses returned different archive heights; using the slowest shard height",
    );
  }

  return merged;
}
