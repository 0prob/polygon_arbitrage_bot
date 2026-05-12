import { normalizeWatchedAddresses } from "./watcher_query.ts";

export type WatcherAddressFilter = {
  addresses: string[];
  addressSet: Set<string>;
};

export type ExtendWatcherAddressFilterResult = WatcherAddressFilter & {
  added: string[];
  rejectedCount: number;
};

export type WatcherAddressFilterUpdate = ExtendWatcherAddressFilterResult & {
  shouldUpdate: boolean;
};

export function buildWatcherAddressFilter(addresses: Iterable<unknown>): WatcherAddressFilter {
  const normalized = normalizeWatchedAddresses([...addresses]);
  return {
    addresses: normalized,
    addressSet: new Set(normalized),
  };
}

export function extendWatcherAddressFilter(
  current: WatcherAddressFilter,
  newAddresses: unknown,
): ExtendWatcherAddressFilterResult {
  if (!Array.isArray(newAddresses) || newAddresses.length === 0) {
    return {
      ...current,
      added: [],
      rejectedCount: 0,
    };
  }

  const normalized = normalizeWatchedAddresses(newAddresses);
  const addressSet = new Set(current.addressSet);
  const added: string[] = [];
  for (const addr of normalized) {
    if (addressSet.has(addr)) continue;
    addressSet.add(addr);
    added.push(addr);
  }

  return {
    addresses: added.length > 0 ? [...current.addresses, ...added] : current.addresses,
    addressSet,
    added,
    rejectedCount: Math.max(0, newAddresses.length - normalized.length),
  };
}

export function updateWatcherAddressFilter(
  current: WatcherAddressFilter,
  newAddresses: unknown,
): WatcherAddressFilterUpdate {
  if (!Array.isArray(newAddresses) || newAddresses.length === 0) {
    return {
      ...current,
      added: [],
      rejectedCount: 0,
      shouldUpdate: false,
    };
  }

  const filter = extendWatcherAddressFilter(current, newAddresses);
  return {
    ...filter,
    shouldUpdate: filter.added.length > 0 || filter.rejectedCount > 0,
  };
}
