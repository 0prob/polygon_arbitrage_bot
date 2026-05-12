import type { RouteStateCache } from "../routing/simulation_types.ts";
import type { WatcherAddressFilter } from "./watcher_filter.ts";
import {
  createWatcherLogHandler,
  type WatcherLogDecoder,
  type WatcherLogHandler,
  type WatcherLogHandlerRegistry,
} from "./watcher_log_handler.ts";
import {
  createWatcherStateAdapters,
  type WatcherStateAdapterRegistry,
  type WatcherStateAdapters,
} from "./watcher_state_adapters.ts";
import type { WatcherEnqueueEnrichment } from "./watcher_types.ts";

export type WatcherRuntimeRegistry = WatcherStateAdapterRegistry & WatcherLogHandlerRegistry;
export type WatcherRuntimeDecoder = WatcherLogDecoder;
export type WatcherRuntimeLogHandler = WatcherLogHandler;
export type WatcherRuntimeStateAdapters = WatcherStateAdapters;

export type WatcherRuntimeAdapterOptions = {
  registry: WatcherRuntimeRegistry;
  cache: RouteStateCache;
  pendingEnrichment: Map<string, unknown>;
  getLastBlock: () => number;
  getEpoch: () => number;
  setEpoch: (epoch: number) => void;
  isClosed: () => boolean;
  isCurrentEpoch: (epoch: number) => boolean;
  setAddressFilter: (filter: WatcherAddressFilter) => void;
  enqueueEnrichment: WatcherEnqueueEnrichment;
  decoder: WatcherLogDecoder;
};

export type WatcherRuntimeAdapters = {
  stateAdapters: WatcherStateAdapters;
  logHandler: WatcherLogHandler;
};

export function createWatcherRuntimeAdapters({
  registry,
  cache,
  pendingEnrichment,
  getLastBlock,
  getEpoch,
  setEpoch,
  isClosed,
  isCurrentEpoch,
  setAddressFilter,
  enqueueEnrichment,
  decoder,
}: WatcherRuntimeAdapterOptions): WatcherRuntimeAdapters {
  const stateAdapters = createWatcherStateAdapters({
    registry,
    cache,
    pendingEnrichment,
    getLastBlock,
    getEpoch,
    setEpoch,
    isClosed,
    isCurrentEpoch,
    setAddressFilter,
  });

  return {
    stateAdapters,
    logHandler: createWatcherLogHandler({
      registry,
      cache,
      stateAdapters,
      getLastBlock,
      getEpoch,
      isClosed,
      isCurrentEpoch,
      enqueueEnrichment,
      decoder,
    }),
  };
}
