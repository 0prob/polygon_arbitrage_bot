import { Decoder } from "../hypersync/client.ts";
import type { HyperSyncRawLog } from "../hypersync/logs.ts";
import type { RouteStateCache } from "../routing/simulation_types.ts";
import { createWatcherRefreshAdapters, type WatcherRefreshRegistry } from "./watcher_refresh.ts";
import { handleWatcherLogs } from "./watcher_state_ops.ts";
import type { WatcherStateAdapters } from "./watcher_state_adapters.ts";
import { WATCHER_SIGNATURES, WATCHER_TOPIC0 } from "./watcher_query.ts";
import { recordWatcherPollTelemetry } from "../utils/metrics.ts";
import type { DecodedWatcherLog, WatcherEnqueueEnrichment, WatcherPoolMeta, WatcherTopicMap } from "./watcher_types.ts";

export type WatcherLogHandlerRegistry = WatcherRefreshRegistry & {
  getPoolMeta?: (addr: string) => WatcherPoolMeta | null | undefined;
};

export type WatcherLogDecoder = {
  decodeLogs: (logs: HyperSyncRawLog[]) => Promise<Array<DecodedWatcherLog | null | undefined>>;
};

export type WatcherLogHandlerStateAdapters = Pick<WatcherStateAdapters, "mergeState" | "commitState" | "commitStates">;

export type WatcherLogHandlerOptions = {
  registry: WatcherLogHandlerRegistry;
  cache: RouteStateCache;
  stateAdapters: WatcherLogHandlerStateAdapters;
  getLastBlock: () => number;
  getEpoch: () => number;
  isClosed: () => boolean;
  isCurrentEpoch: (epoch: number) => boolean;
  enqueueEnrichment: WatcherEnqueueEnrichment;
  decoder?: WatcherLogDecoder;
  topic0?: WatcherTopicMap;
};

export type WatcherLogHandler = (logs: HyperSyncRawLog[]) => Promise<Set<string>>;

export function createWatcherLogHandler({
  registry,
  cache,
  stateAdapters,
  getLastBlock,
  getEpoch,
  isClosed,
  isCurrentEpoch,
  enqueueEnrichment,
  decoder = Decoder.fromSignatures(WATCHER_SIGNATURES) as WatcherLogDecoder,
  topic0 = WATCHER_TOPIC0,
}: WatcherLogHandlerOptions): WatcherLogHandler {
  const refreshers = createWatcherRefreshAdapters({
    registry,
    lastBlock: getLastBlock,
    currentEpoch: getEpoch,
    isClosed,
    isCurrentEpoch,
    mergeState: stateAdapters.mergeState,
    commitState: stateAdapters.commitState,
  });

  return async (logs) => {
    const decodeStartedAt = Date.now();
    const decoded = await decoder.decodeLogs(logs);
    const decodeMs = Date.now() - decodeStartedAt;
    const stateStartedAt = Date.now();
    const changed = await handleWatcherLogs({
      logs,
      decoded,
      registry,
      cache,
      closed: isClosed,
      topic0,
      refreshBalancer: refreshers.refreshBalancer,
      refreshCurve: refreshers.refreshCurve,
      refreshDodo: refreshers.refreshDodo,
      refreshWoofi: refreshers.refreshWoofi,
      refreshV3: refreshers.refreshV3,
      enqueueEnrichment,
      commitStates: stateAdapters.commitStates,
    });
    recordWatcherPollTelemetry({
      decodeMs,
      stateCommitMs: Date.now() - stateStartedAt,
    });
    return changed;
  };
}
