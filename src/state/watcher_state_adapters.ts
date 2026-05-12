import type { HyperSyncRawLog } from "../hypersync/logs.ts";
import type { RouteStateCache } from "../routing/simulation_types.ts";
import { buildWatcherAddressFilter } from "./watcher_filter.ts";
import {
  commitWatcherState,
  commitWatcherStatesBatch,
  mergeWatcherState,
  persistWatcherState,
  persistWatcherStates,
  reloadWatcherCache,
} from "./watcher_state_ops.ts";
import type {
  MutableWatcherState,
  WatcherPersistedStateUpdate,
  WatcherStateUpdate,
} from "./watcher_types.ts";

export type WatcherStateAdapterRegistry = {
  updatePoolState?: (state: WatcherPersistedStateUpdate) => unknown;
  batchUpdateStates?: (states: WatcherPersistedStateUpdate[]) => unknown;
  getPools?: Parameters<typeof reloadWatcherCache>[0]["getPools"];
};

type WatcherAddressFilter = ReturnType<typeof buildWatcherAddressFilter>;

export type WatcherStateAdapterOptions = {
  registry: WatcherStateAdapterRegistry;
  cache: RouteStateCache;
  pendingEnrichment: Map<string, unknown>;
  getLastBlock: () => number;
  getEpoch: () => number;
  setEpoch: (epoch: number) => void;
  isClosed: () => boolean;
  isCurrentEpoch: (epoch: number) => boolean;
  setAddressFilter: (filter: WatcherAddressFilter) => void;
};

export type WatcherStateAdapters = {
  commitState: (
    addr: string,
    state: MutableWatcherState,
    rawLog: HyperSyncRawLog,
    expectedEpoch?: number,
  ) => void;
  commitStates: (
    updates: WatcherStateUpdate[],
    expectedEpoch?: number,
  ) => string[];
  mergeState: (addr: string, nextState: MutableWatcherState) => MutableWatcherState;
  reloadCacheFromRegistry: () => Set<string>;
  advanceEnrichmentEpoch: () => number;
};

function requireStateWriter(registry: WatcherStateAdapterRegistry) {
  if (!registry.updatePoolState) {
    throw new Error("Watcher registry does not support state persistence.");
  }
  return registry as WatcherStateAdapterRegistry & Required<Pick<WatcherStateAdapterRegistry, "updatePoolState">>;
}

function requireStateBatchWriter(registry: WatcherStateAdapterRegistry) {
  if (!registry.batchUpdateStates) {
    throw new Error("Watcher registry does not support batch state persistence.");
  }
  return registry as WatcherStateAdapterRegistry & Required<Pick<WatcherStateAdapterRegistry, "batchUpdateStates">>;
}

function requireCacheSource(registry: WatcherStateAdapterRegistry) {
  if (!registry.getPools) return null;
  return registry as WatcherStateAdapterRegistry & Required<Pick<WatcherStateAdapterRegistry, "getPools">>;
}

export function createWatcherStateAdapters({
  registry,
  cache,
  pendingEnrichment,
  getLastBlock,
  getEpoch,
  setEpoch,
  isClosed,
  isCurrentEpoch,
  setAddressFilter,
}: WatcherStateAdapterOptions): WatcherStateAdapters {
  const persistState = (addr: string, state: MutableWatcherState, rawLog: HyperSyncRawLog) => {
    persistWatcherState(requireStateWriter(registry), addr, state, rawLog, getLastBlock());
  };

  const persistStates = (states: WatcherPersistedStateUpdate[]) => {
    persistWatcherStates(requireStateBatchWriter(registry), states, getLastBlock());
  };

  return {
    commitState: (addr, state, rawLog, expectedEpoch = getEpoch()) => {
      if (isClosed() || !isCurrentEpoch(expectedEpoch)) return;
      commitWatcherState(cache, persistState, addr, state, rawLog);
    },
    commitStates: (updates, expectedEpoch = getEpoch()) => {
      if (isClosed() || !isCurrentEpoch(expectedEpoch)) return [];
      return commitWatcherStatesBatch(cache, persistStates, updates);
    },
    mergeState: (addr, nextState) => mergeWatcherState(cache, addr, nextState),
    reloadCacheFromRegistry: () => {
      const cacheSource = requireCacheSource(registry);
      if (!cacheSource) return new Set<string>();
      const filter = buildWatcherAddressFilter(
        reloadWatcherCache(cacheSource, cache, pendingEnrichment),
      );
      setAddressFilter(filter);
      return filter.addressSet;
    },
    advanceEnrichmentEpoch: () => {
      const nextEpoch = getEpoch() + 1;
      setEpoch(nextEpoch);
      pendingEnrichment.clear();
      return nextEpoch;
    },
  };
}
