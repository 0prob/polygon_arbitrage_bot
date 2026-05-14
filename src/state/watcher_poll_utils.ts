import { compareHyperSyncLogs, hyperSyncLogIdentityKey, normalizeHyperSyncLogMeta } from "../hypersync/logs.ts";
import type { HyperSyncRawLog } from "../hypersync/logs.ts";

const WATCHER_TRANSIENT_ERROR_SLEEP_MS = 5_000;
const WATCHER_INTEGRITY_ERROR_SLEEP_MS = 15_000;
const WATCHER_RATE_LIMIT_BASE_MS = 2_000;
const WATCHER_TIMEOUT_BASE_MS = 1_000;
const WATCHER_TRANSIENT_ERROR_SLEEP_MAX_MS = 30_000;
const WATCHER_RATE_LIMIT_MAX_MS = 60_000;
const WATCHER_TIMEOUT_MAX_MS = 15_000;
export const WATCHER_MAX_CONSECUTIVE_INTEGRITY_ERRORS = 3;
const WATCHER_SHARD_TRANSIENT_RETRY_BASE_MS = 250;
const WATCHER_SHARD_ARCHIVE_HEIGHT_WARN_SPREAD = 25;

export type RollbackGuard = {
  block_number?: unknown;
  blockNumber?: unknown;
  block_hash?: unknown;
  blockHash?: unknown;
  hash?: unknown;
  first_block_number?: unknown;
  firstBlockNumber?: unknown;
  first_parent_hash?: unknown;
  firstParentHash?: unknown;
  [key: string]: unknown;
};

export type WatcherShardFailure = {
  shardIndex: number;
  reason: unknown;
};

export type WatcherShardFailureMeta = {
  shardIndex: number;
  errorName: string | null;
  error: string;
};

export type WatcherShardRequestError = Error & {
  shardFailures: WatcherShardFailureMeta[];
};

export type WatcherErrorCategory = "transient" | "integrity" | "rate_limit" | "timeout";
type WatcherArchiveHeightLogLevel = "warn" | "debug";

type WatcherPollErrorLike = {
  message?: string;
  name?: string;
  poolAddress?: string;
  validationReason?: string;
  blockNumber?: number;
  transactionHash?: string;
  topic0?: string;
  shardFailures?: unknown;
};

export type WatcherShardSummary = {
  archiveHeights?: number[] | null;
};

export type WatcherRollbackResult = {
  poolsRemoved?: unknown;
  statesRemoved?: unknown;
};

function rollbackGuardHeadBlock(guard: RollbackGuard | null | undefined) {
  const numeric = Number(guard?.block_number ?? guard?.blockNumber);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
}

function rollbackGuardHeadHash(guard: RollbackGuard | null | undefined) {
  const hash = String(guard?.block_hash ?? guard?.blockHash ?? guard?.hash ?? "").trim();
  return hash.length > 0 ? hash : null;
}

export function compareRollbackGuards(a: RollbackGuard | null | undefined, b: RollbackGuard | null | undefined) {
  const aHeadBlock = rollbackGuardHeadBlock(a);
  const bHeadBlock = rollbackGuardHeadBlock(b);
  const aHeadHash = rollbackGuardHeadHash(a);
  const bHeadHash = rollbackGuardHeadHash(b);
  if (aHeadBlock != null && bHeadBlock != null && aHeadHash && bHeadHash && aHeadBlock === bHeadBlock && aHeadHash !== bHeadHash) {
    return false;
  }

  const aFirstBlock = Number(a?.first_block_number ?? a?.firstBlockNumber);
  const bFirstBlock = Number(b?.first_block_number ?? b?.firstBlockNumber);
  const aFirstParent = String(a?.first_parent_hash ?? a?.firstParentHash ?? "");
  const bFirstParent = String(b?.first_parent_hash ?? b?.firstParentHash ?? "");
  if (
    Number.isFinite(aFirstBlock) &&
    Number.isFinite(bFirstBlock) &&
    aFirstParent &&
    bFirstParent &&
    aFirstBlock === bFirstBlock &&
    aFirstParent !== bFirstParent
  ) {
    return false;
  }

  return true;
}

export function isRollbackGuardMismatchError(error: unknown) {
  const message = String((error as { message?: string } | null | undefined)?.message ?? error ?? "").toLowerCase();
  return message.includes("mismatched rollback guards") || message.includes("inconsistent chain views");
}

export function watcherShardRetryDelayMs(attempt: number) {
  return WATCHER_SHARD_TRANSIENT_RETRY_BASE_MS * Math.max(1, 2 ** Math.max(0, attempt));
}

export function watcherShardFailureError(failures: WatcherShardFailure[]) {
  const detail = failures
    .map(({ shardIndex, reason }) => {
      const err = reason as { message?: string } | null | undefined;
      return `shard ${shardIndex}: ${String(err?.message ?? reason ?? "unknown error")}`;
    })
    .join("; ");
  const err = new Error(`Watcher shard request failed (${detail})`) as WatcherShardRequestError;
  err.name = "WatcherShardRequestError";
  err.shardFailures = failures.map(({ shardIndex, reason }) => {
    const err = reason as { message?: string; name?: string } | null | undefined;
    return {
      shardIndex,
      errorName: err?.name ?? null,
      error: String(err?.message ?? reason ?? "unknown error"),
    };
  });
  return err;
}

export function watcherShardArchiveHeightMeta(archiveHeights: Iterable<number>) {
  const heights = [...archiveHeights].filter(Number.isFinite).sort((a, b) => a - b);
  const min = heights.length > 0 ? heights[0] : null;
  const max = heights.length > 0 ? heights[heights.length - 1] : null;
  const spread = min != null && max != null ? max - min : 0;
  const logLevel: WatcherArchiveHeightLogLevel = heights.length > 1 && spread > WATCHER_SHARD_ARCHIVE_HEIGHT_WARN_SPREAD ? "warn" : "debug";
  return {
    archiveHeights: heights,
    archiveHeightSpread: spread,
    logLevel,
  };
}

export function mergeRollbackGuards(base: RollbackGuard | null | undefined, next: RollbackGuard | null | undefined): RollbackGuard | null {
  if (!base) return next ?? null;
  if (!next) return base;
  const baseHeadBlock = rollbackGuardHeadBlock(base);
  const nextHeadBlock = rollbackGuardHeadBlock(next);
  const primary =
    baseHeadBlock != null && nextHeadBlock != null && nextHeadBlock < baseHeadBlock
      ? next
      : baseHeadBlock == null && nextHeadBlock != null
        ? next
        : base;
  const secondary = primary === base ? next : base;
  const merged = { ...secondary, ...primary } as Record<string, unknown>;
  const headBlock = primary?.block_number ?? primary?.blockNumber ?? secondary?.block_number ?? secondary?.blockNumber;
  const headHash =
    primary?.block_hash ?? primary?.blockHash ?? primary?.hash ?? secondary?.block_hash ?? secondary?.blockHash ?? secondary?.hash;
  const firstBlock =
    primary?.first_block_number ?? primary?.firstBlockNumber ?? secondary?.first_block_number ?? secondary?.firstBlockNumber;
  const firstParent = primary?.first_parent_hash ?? primary?.firstParentHash ?? secondary?.first_parent_hash ?? secondary?.firstParentHash;

  if (headBlock != null) merged.block_number = headBlock;
  if (headHash != null) {
    merged.block_hash = headHash;
    merged.hash = headHash;
  }
  if (firstBlock != null) merged.first_block_number = firstBlock;
  if (firstParent != null) merged.first_parent_hash = firstParent;

  delete merged.blockNumber;
  delete merged.blockHash;
  delete merged.firstBlockNumber;
  delete merged.firstParentHash;

  return merged;
}

export function watcherLogIsBeforeNextBlock(log: HyperSyncRawLog, nextBlock: number | null) {
  if (nextBlock == null) return true;
  const blockNumber = normalizeHyperSyncLogMeta(log).blockNumber;
  return blockNumber == null || blockNumber < nextBlock;
}

export function sortWatcherLogs(logs: HyperSyncRawLog[]) {
  if (!Array.isArray(logs) || logs.length <= 1) return logs ?? [];
  return [...logs].sort(compareHyperSyncLogs);
}

export function dedupeWatcherLogs(logs: HyperSyncRawLog[]) {
  if (!Array.isArray(logs) || logs.length <= 1) return logs ?? [];

  const seen = new Set<string>();
  const deduped: HyperSyncRawLog[] = [];
  for (const log of logs) {
    const identity = hyperSyncLogIdentityKey(log);
    if (!identity) {
      deduped.push(log);
      continue;
    }
    if (seen.has(identity)) continue;
    seen.add(identity);
    deduped.push(log);
  }
  return deduped;
}

export function parseWatcherBlock(name: string, value: unknown) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new Error(`Watcher ${name} must be a finite non-negative safe integer.`);
  }
  return numeric;
}

export function parseOptionalWatcherBlock(name: string, value: unknown) {
  if (value == null) return null;
  return parseWatcherBlock(name, value);
}

export function watcherCheckpointFromNextBlock(nextBlock: unknown, currentLastBlock: unknown, archiveHeight?: unknown) {
  const numericNextBlock = Number(nextBlock);
  if (!Number.isSafeInteger(numericNextBlock) || numericNextBlock < 0) {
    throw new Error("HyperSync response did not include a finite nextBlock cursor; cannot advance watcher safely.");
  }

  const numericCurrentLastBlock = parseWatcherBlock("currentLastBlock", currentLastBlock);
  const requestedFromBlock = numericCurrentLastBlock + 1;
  if (numericNextBlock < requestedFromBlock) {
    throw new Error(
      `HyperSync nextBlock cursor regressed from requested block ${requestedFromBlock} to ${numericNextBlock}; cannot advance watcher safely.`,
    );
  }

  const numericArchiveHeight = parseOptionalWatcherBlock("archiveHeight", archiveHeight);
  if (numericNextBlock === requestedFromBlock && numericArchiveHeight == null) {
    throw new Error(`HyperSync nextBlock cursor stalled at ${numericNextBlock} without archive height; cannot advance watcher safely.`);
  }
  if (numericNextBlock === requestedFromBlock && numericArchiveHeight != null && numericArchiveHeight > requestedFromBlock) {
    throw new Error(
      `HyperSync nextBlock cursor stalled at ${numericNextBlock} before archive height ${numericArchiveHeight}; cannot advance watcher safely.`,
    );
  }

  if (numericNextBlock > 0) {
    return numericNextBlock - 1;
  }
  return numericCurrentLastBlock;
}

export function watcherProgressMeta(
  nextBlock: unknown,
  currentLastBlock: unknown,
  archiveHeight: unknown,
  logCount = 0,
  shardSummary: WatcherShardSummary | null = null,
) {
  const numericNextBlock = parseWatcherBlock("nextBlock", nextBlock);
  const numericArchiveHeight = parseOptionalWatcherBlock("archiveHeight", archiveHeight);
  const numericCurrentLastBlock = parseWatcherBlock("currentLastBlock", currentLastBlock);
  const checkpointBlock = watcherCheckpointFromNextBlock(numericNextBlock, numericCurrentLastBlock, numericArchiveHeight);
  const requestedFromBlock = numericCurrentLastBlock + 1;
  const advancedBlocks = Math.max(0, checkpointBlock - numericCurrentLastBlock);
  const caughtUp = numericArchiveHeight != null && numericNextBlock >= numericArchiveHeight;
  const hadLogs = Number(logCount) > 0;
  const archiveHeights =
    Array.isArray(shardSummary?.archiveHeights) && shardSummary.archiveHeights.length > 0
      ? [...shardSummary.archiveHeights].map((height) => parseWatcherBlock("shard archiveHeight", height))
      : null;

  // Calculate poll lag for adaptive sleep
  const pollLagBlocks = numericArchiveHeight != null ? Math.max(0, numericArchiveHeight - checkpointBlock) : null;

  let waitReason = null;
  if (!hadLogs) {
    waitReason = "empty_poll";
  } else if (caughtUp) {
    waitReason = "caught_up";
  }

  return {
    requestedFromBlock,
    nextBlock: numericNextBlock,
    archiveHeight: numericArchiveHeight,
    checkpointBlock,
    advancedBlocks,
    hadLogs,
    caughtUp,
    waitReason,
    pollLagBlocks, // Added for adaptive sleep calculation
    constrainedBySlowestShardArchiveHeight: Array.isArray(archiveHeights) && archiveHeights.length > 1,
    shardArchiveHeights: archiveHeights,
  };
}

export function watcherErrorBackoffMeta(
  error: unknown,
  consecutivePollErrors: number,
  backoffMs: number,
  currentLastBlock: unknown,
  errorCategory: WatcherErrorCategory | null = null,
) {
  const err = error as WatcherPollErrorLike | null | undefined;
  return {
    error: String(err?.message ?? error ?? "Unknown watcher error"),
    errorName: err?.name ?? null,
    errorCategory,
    shardFailures: Array.isArray(err?.shardFailures) ? err.shardFailures : undefined,
    poolAddress: err?.poolAddress ?? undefined,
    validationReason: err?.validationReason ?? undefined,
    blockNumber: Number.isFinite(Number(err?.blockNumber)) ? Number(err?.blockNumber) : undefined,
    transactionHash: err?.transactionHash ?? undefined,
    topic0: err?.topic0 ?? undefined,
    consecutivePollErrors: Math.max(1, Number(consecutivePollErrors) || 1),
    backoffMs: Math.max(0, Number(backoffMs) || 0),
    currentLastBlock: Math.max(0, Number(currentLastBlock) || 0),
  };
}

export function classifyWatcherPollError(error: unknown): WatcherErrorCategory {
  const err = error as { message?: string; name?: string; code?: string | number } | null | undefined;
  const name = String(err?.name ?? "").toLowerCase();
  const message = String(err?.message ?? error ?? "").toLowerCase();
  const code = String(err?.code ?? "").toLowerCase();

  // Rate limiting (429, rate limit mentions)
  if (
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("429") ||
    code === "429" ||
    name.includes("ratelimit")
  ) {
    return "rate_limit";
  }

  // Timeout errors
  if (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("deadline") ||
    message.includes("etimedout") ||
    code === "etimedout" ||
    code === "etimeout"
  ) {
    return "timeout";
  }

  // Integrity errors (data consistency issues)
  if (
    message.includes("mismatched rollback guards") ||
    message.includes("inconsistent chain views") ||
    name === "watcherstateintegrityerror" ||
    name === "watcherstateupdateerror" ||
    message.includes("watcher state integrity failed") ||
    message.includes("watcher update failed") ||
    message.includes("invalid timestamp") ||
    message.includes("invalid watcher state") ||
    message.includes("did not include a finite nextblock cursor") ||
    message.includes("stalled at") ||
    message.includes("regressed from requested block") ||
    message.includes("incomplete shard metadata")
  ) {
    return "integrity";
  }

  // Shard request failures are transient
  if (message.includes("watcher shard request failed")) {
    return "transient";
  }

  // Default to transient for unknown errors
  return "transient";
}

export function watcherErrorBackoffMs(error: unknown, consecutivePollErrors: number): number {
  const category = classifyWatcherPollError(error);
  const streak = Math.max(1, Number(consecutivePollErrors) || 1);

  // Integrity errors: fixed long delay (data consistency issue)
  if (category === "integrity") {
    return WATCHER_INTEGRITY_ERROR_SLEEP_MS;
  }

  // Rate limiting: exponential backoff with higher ceiling
  if (category === "rate_limit") {
    const backoff = Math.min(WATCHER_RATE_LIMIT_BASE_MS * Math.pow(2, streak - 1), WATCHER_RATE_LIMIT_MAX_MS);
    return backoff;
  }

  // Timeout: moderate backoff, retry sooner
  if (category === "timeout") {
    const backoff = Math.min(WATCHER_TIMEOUT_BASE_MS * Math.pow(2, streak - 1), WATCHER_TIMEOUT_MAX_MS);
    return backoff;
  }

  // Transient errors: standard exponential backoff
  return Math.min(WATCHER_TRANSIENT_ERROR_SLEEP_MS * Math.max(1, 2 ** (streak - 1)), WATCHER_TRANSIENT_ERROR_SLEEP_MAX_MS);
}

export function watcherShouldHaltAfterIntegrityError(consecutiveIntegrityErrors: number) {
  return Math.max(0, Number(consecutiveIntegrityErrors) || 0) >= WATCHER_MAX_CONSECUTIVE_INTEGRITY_ERRORS;
}

export function watcherReorgMeta(
  reorgBlock: unknown,
  rollbackResult: WatcherRollbackResult | null | undefined,
  changedAddrs: unknown,
  checkpointBlock: unknown,
) {
  const changedAddrCount = Array.isArray(changedAddrs) ? changedAddrs.length : changedAddrs instanceof Set ? changedAddrs.size : 0;
  return {
    reorgBlock: Math.max(0, Number(reorgBlock) || 0),
    checkpointBlock: Math.max(0, Number(checkpointBlock) || 0),
    poolsRemoved: Math.max(0, Number(rollbackResult?.poolsRemoved) || 0),
    statesRemoved: Math.max(0, Number(rollbackResult?.statesRemoved) || 0),
    cacheEntriesReloaded: changedAddrCount,
  };
}

export function watcherHaltMeta(error: unknown, consecutiveIntegrityPollErrors: number, haltThreshold: number, currentLastBlock: unknown) {
  const err = error as { message?: string; name?: string } | null | undefined;
  return {
    reason: String(err?.message ?? error ?? "Unknown watcher halt reason"),
    errorName: err?.name ?? null,
    consecutiveIntegrityPollErrors: Math.max(0, Number(consecutiveIntegrityPollErrors) || 0),
    haltThreshold: Math.max(0, Number(haltThreshold) || 0),
    currentLastBlock: Math.max(0, Number(currentLastBlock) || 0),
  };
}
