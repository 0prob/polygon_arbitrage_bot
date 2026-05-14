import { buildWatcherAddressFilter, type WatcherAddressFilter } from "./watcher_filter.ts";

export const WATCHER_LOOKBACK_BLOCKS = 100;

export type WatcherCheckpointRecord = {
  last_block?: unknown;
};

export type WatcherStartRegistry = {
  getCheckpoint?: (key: string) => WatcherCheckpointRecord | null | undefined;
  getGlobalCheckpoint?: () => unknown;
};

export type WatcherStartBlockSource = "explicit" | "checkpoint" | "global_checkpoint" | "lookback" | "fallback_zero";

export type WatcherStartBlockResolution = {
  startBlock: number;
  source: WatcherStartBlockSource;
  lookbackBlocks?: number;
};

export type WatcherStartupLogger = {
  info: (meta: unknown, message: string) => unknown;
};

export type ResolveWatcherStartBlockOptions = {
  fromBlock: unknown;
  registry: WatcherStartRegistry;
  checkpointKey: string;
  getHeight: () => Promise<unknown>;
  lookbackBlocks?: number;
};

export type InitializeWatcherStartOptions = ResolveWatcherStartBlockOptions & {
  cacheKeys: Iterable<unknown>;
  logger?: WatcherStartupLogger | null;
};

export type WatcherStartInitialization = WatcherStartBlockResolution & {
  filter: WatcherAddressFilter;
};

export async function resolveWatcherStartBlock({
  fromBlock,
  registry,
  checkpointKey,
  getHeight,
  lookbackBlocks = WATCHER_LOOKBACK_BLOCKS,
}: ResolveWatcherStartBlockOptions): Promise<WatcherStartBlockResolution> {
  if (fromBlock != null) {
    const numericBlock = Number(fromBlock);
    if (!Number.isFinite(numericBlock)) throw new Error(`Watcher startup: fromBlock is not a valid number: ${fromBlock}`);
    return { startBlock: Math.max(0, numericBlock), source: "explicit" };
  }

  const checkpoint = registry.getCheckpoint?.(checkpointKey);
  if (checkpoint && Number.isFinite(Number(checkpoint.last_block))) {
    return {
      startBlock: Math.max(0, Number(checkpoint.last_block)),
      source: "checkpoint",
    };
  }

  const globalCheckpoint = Number(registry.getGlobalCheckpoint?.());
  if (Number.isFinite(globalCheckpoint) && globalCheckpoint >= 0) {
    return {
      startBlock: Math.max(0, globalCheckpoint),
      source: "global_checkpoint",
    };
  }

  try {
    const height = Number(await getHeight());
    if (!Number.isFinite(height)) throw new Error(`Watcher startup: chain height is not a valid number: ${height}`);
    return {
      startBlock: Math.max(0, height - lookbackBlocks),
      source: "lookback",
      lookbackBlocks,
    };
  } catch {
    return { startBlock: 0, source: "fallback_zero", lookbackBlocks };
  }
}

export async function initializeWatcherStart({
  cacheKeys,
  logger,
  ...startOptions
}: InitializeWatcherStartOptions): Promise<WatcherStartInitialization> {
  const startBlock = await resolveWatcherStartBlock(startOptions);
  if (startBlock.source === "global_checkpoint") {
    logger?.info({ startBlock: startBlock.startBlock }, "No watcher checkpoint found; resuming from global checkpoint");
  } else if (startBlock.source === "lookback") {
    logger?.info(
      {
        startBlock: startBlock.startBlock,
        lookbackBlocks: startBlock.lookbackBlocks,
      },
      "No checkpoint found; starting from lookback block",
    );
  }

  return {
    ...startBlock,
    filter: buildWatcherAddressFilter(cacheKeys),
  };
}
