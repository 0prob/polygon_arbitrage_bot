/**
 * src/state/cache_utils.js — Cache merge/reload helpers used by the watcher
 *
 * Kept dependency-free so recovery logic can be tested without loading the
 * HyperSync client.
 */

import { getPoolTokens } from "../utils/pool_record.ts";
import type { RouteState, RouteStateCache } from "../routing/simulation_types.ts";

type RegistryPoolRecord = {
  pool_address: string;
  protocol?: unknown;
  tokens?: unknown;
  state?: { data?: RouteState | null } | null;
};

type RegistryCacheSource = {
  getPools: (opts?: { status?: string }) => RegistryPoolRecord[];
};

type PendingEnrichmentMap = Map<string, unknown>;

const CORE_STATE_KEYS = new Set(["poolId", "protocol", "tokens", "timestamp", "token0", "token1"]);

export function mergeStateIntoCache(cache: RouteStateCache, addr: string, nextState: RouteState): RouteState {
  const current = cache.get(addr);
  if (!current) {
    cache.set(addr, nextState);
    return nextState;
  }

  for (const key of Object.keys(current)) {
    if (CORE_STATE_KEYS.has(key)) continue;
    if (!Object.hasOwn(nextState, key)) {
      delete current[key];
    }
  }

  for (const [key, value] of Object.entries(nextState)) {
    current[key] = value;
  }

  return current;
}

export function reloadCacheFromRegistry(
  registry: RegistryCacheSource,
  cache: RouteStateCache,
  pendingEnrichment: PendingEnrichmentMap = new Map(),
): Set<string> {
  const pools = registry.getPools({ status: "active" });
  const nextAddrs = new Set<string>();

  for (const pool of pools) {
    const addr = pool.pool_address.toLowerCase();
    nextAddrs.add(addr);

    let nextState: RouteState;
    if (pool.state?.data) {
      nextState = pool.state.data;
    } else {
      // Use an identity-field placeholder so validatePoolState can progress past
      // poolId/protocol/tokens checks once the watcher re-populates numeric fields.
      const tokens = getPoolTokens(pool);
      nextState = {
        poolId: addr,
        protocol: pool.protocol,
        tokens,
        timestamp: 0,
      };
    }

    const merged = mergeStateIntoCache(cache, addr, nextState);
    cache.set(addr, merged);
  }

  for (const addr of [...cache.keys()]) {
    if (!nextAddrs.has(addr)) {
      cache.delete(addr);
      pendingEnrichment.delete(addr);
    }
  }

  return nextAddrs;
}
