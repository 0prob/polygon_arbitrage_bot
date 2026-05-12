
/**
 * src/state/watcher_state_ops.js — State mutation helpers for StateWatcher
 */

import { mergeStateIntoCache, reloadCacheFromRegistry } from "./cache_utils.ts";
import { createWatcherProtocolHandlers } from "./watcher_protocol_handlers.ts";
import {
  DODO_PROTOCOLS,
  resolveV2FeeDenominator,
  resolveV2FeeNumerator,
  resolveV3Fee,
  V3_PROTOCOLS,
  validatePoolState,
} from "./normalizer.ts";
import { logger } from "../utils/logger.ts";
import { parsePoolMetadataValue } from "../utils/pool_record.ts";
import { topicArrayFromHyperSyncLog } from "../hypersync/logs.ts";
import type { HyperSyncRawLog } from "../hypersync/logs.ts";
import type {
  DecodedWatcherLog,
  MutableWatcherState,
  V3WatcherTickState,
  WatcherEnqueueEnrichment,
  WatcherPersistedStateUpdate,
  WatcherPoolRefresh,
  WatcherPoolMeta,
  WatcherStateUpdate,
  WatcherTopicMap,
  WatcherV3Refresh,
} from "./watcher_types.ts";
import type { RouteStateCache } from "../routing/simulation_types.ts";

const watcherStateLogger = logger.child({ component: "watcher_state_ops" });

function isTickRecord(value: unknown): value is Partial<V3WatcherTickState> {
  return value != null && typeof value === "object";
}

function toTickBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
  return 0n;
}

function tickEntriesFrom(value: unknown): Array<[unknown, unknown]> {
  if (!value) return [];
  if (value instanceof Map) return [...value.entries()];
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (Array.isArray(entry) && entry.length >= 2) return [entry[0], entry[1]] as [unknown, unknown];
        if (isTickRecord(entry) && ("tick" in entry || "index" in entry)) {
          const record = entry as Record<string, unknown>;
          return [record.tick ?? record.index, entry] as [unknown, unknown];
        }
        return null;
      })
      .filter((entry): entry is [unknown, unknown] => entry != null);
  }
  if (typeof value === "object") return Object.entries(value);
  return [];
}

function normalizeWatcherTicks(ticks: unknown): Map<number, V3WatcherTickState> {
  if (ticks instanceof Map) return ticks;
  const normalized = new Map<number, V3WatcherTickState>();
  for (const [tick, data] of tickEntriesFrom(ticks)) {
    if (!isTickRecord(data)) continue;
    const tickNumber = Number(tick);
    if (!Number.isInteger(tickNumber)) continue;
    normalized.set(tickNumber, {
      liquidityGross: toTickBigInt(data.liquidityGross),
      liquidityNet: toTickBigInt(data.liquidityNet),
    });
  }
  return normalized;
}

type WatcherStateUpdateError = Error & {
  poolAddress?: string;
  validationReason?: string;
  blockNumber?: number;
  transactionHash?: string;
  topic0?: string | null;
  cause?: unknown;
};

type WatcherStateIntegrityError = Error & {
  poolAddress: string;
  validationReason: string;
  blockNumber?: number;
  transactionHash?: string;
  topic0?: string | null;
};

type WatcherStateIntegrityContext = {
  addr?: unknown;
  poolAddress?: unknown;
  rawLog?: HyperSyncRawLog | null;
};

type RecoverInvalidV3LiquidityMutationInput = {
  addr: string;
  log: HyperSyncRawLog;
  pool: WatcherPoolMeta | null;
  state: MutableWatcherState;
  topic?: string;
  topic0: WatcherTopicMap;
  enqueueEnrichment: WatcherEnqueueEnrichment;
  refreshV3: WatcherV3Refresh;
};

type WatcherStateWriter = {
  updatePoolState: (state: WatcherPersistedStateUpdate) => unknown;
};

type WatcherStateBatchWriter = {
  batchUpdateStates: (states: WatcherPersistedStateUpdate[]) => unknown;
};

type WatcherPersistedStateInput = {
  pool_address?: unknown;
  block?: unknown;
  data?: MutableWatcherState | null;
};

function errorMessage(error: unknown) {
  return String((error as { message?: unknown } | null | undefined)?.message ?? error ?? "unknown error");
}

function errorValidationReason(error: unknown, fallback: string) {
  const err = error as { validationReason?: unknown; message?: unknown } | null | undefined;
  return String(err?.validationReason ?? err?.message ?? error ?? fallback);
}

function noopPoolRefresh() {}

export function toTopicArray(log: HyperSyncRawLog) {
  return topicArrayFromHyperSyncLog(log);
}

export async function handleWatcherLogs({
  logs,
  decoded,
  registry,
  cache,
  closed,
  topic0,
  refreshBalancer,
  refreshCurve,
  refreshDodo,
  refreshWoofi,
  refreshV3,
  enqueueEnrichment,
  commitStates,
}: {
  logs: HyperSyncRawLog[];
  decoded: Array<DecodedWatcherLog | null | undefined>;
  registry: {
    getPoolMeta?: (addr: string) => WatcherPoolMeta | null | undefined;
  };
  cache: RouteStateCache;
  closed: () => boolean;
  topic0: WatcherTopicMap;
  refreshBalancer: WatcherPoolRefresh;
  refreshCurve: WatcherPoolRefresh;
  refreshDodo?: WatcherPoolRefresh;
  refreshWoofi?: WatcherPoolRefresh;
  refreshV3: WatcherV3Refresh;
  enqueueEnrichment: WatcherEnqueueEnrichment;
  commitStates: (updates: WatcherStateUpdate[]) => Iterable<string>;
}) {
  const changedAddrs = new Set<string>();
  // Cache protocol handlers once per batch instead of per-log
  const protocolHandlers = createWatcherProtocolHandlers({
    topic0,
    updateV2State,
    updateV3SwapState,
    updateV3LiquidityState,
  });
  const pendingStateUpdates = new Map<string, WatcherStateUpdate>();
  const poolMetaCache = new Map<string, WatcherPoolMeta | null>();
  const refreshingV3Addrs = new Set<string>();

  for (let i = 0; i < logs.length; i++) {
    const log = logs[i];
    const dec = decoded[i];
    if (!dec) continue;
    if (closed()) break;

    // Fast address extraction — avoid String() allocation for empty addresses
    const addrRaw = log.address;
    if (!addrRaw) continue;
    const addr = typeof addrRaw === "string" ? addrRaw.toLowerCase() : String(addrRaw).toLowerCase();
    if (!addr || addr.length !== 42) continue;
    if (refreshingV3Addrs.has(addr)) continue;

    // Pool meta lookup with local cache (avoids repeated registry lookups)
    let pool = poolMetaCache.get(addr);
    if (pool === undefined) {
      pool = registry.getPoolMeta?.(addr) ?? null;
      poolMetaCache.set(addr, pool);
    }
    if (!pool) continue;

    const topic = toTopicArray(log)[0];
    const handler = protocolHandlers.get(topic);
    if (!handler) continue;

    let pending = pendingStateUpdates.get(addr);
    const hadPending = pending != null;
    if (!pending) {
      const state = cloneWatcherState(cache.get(addr));
      if (!state) continue;
      pending = { addr, state, rawLog: log };
      pendingStateUpdates.set(addr, pending);
    }

    const state = pending.state;

    try {
      if (handler({
        addr,
        log,
        pool,
        state,
        decoded: dec,
        enqueueEnrichment,
        refreshBalancer,
        refreshCurve,
        refreshDodo: refreshDodo ?? noopPoolRefresh,
        refreshWoofi: refreshWoofi ?? noopPoolRefresh,
        refreshV3,
      })) {
        pending.rawLog = log;
        if (recoverInvalidV3LiquidityMutation({
          addr,
          log,
          pool,
          state,
          topic,
          topic0,
          enqueueEnrichment,
          refreshV3,
        })) {
          pendingStateUpdates.delete(addr);
          refreshingV3Addrs.add(addr);
        }
      } else if (!hadPending) {
        pendingStateUpdates.delete(addr);
      }
    } catch (err) {
      watcherStateLogger.error({ poolAddress: addr, err }, "Watcher state update failed");
      const updateError = new Error(`watcher update failed for ${addr}: ${errorMessage(err)}`) as WatcherStateUpdateError;
      updateError.name = "WatcherStateUpdateError";
      updateError.poolAddress = addr;
      updateError.validationReason = errorValidationReason(err, "watcher update failed");
      updateError.blockNumber = Number(log?.blockNumber);
      updateError.transactionHash = log?.transactionHash != null ? String(log.transactionHash) : undefined;
      updateError.topic0 = toTopicArray(log)[0] ?? null;
      updateError.cause = err;
      throw updateError;
    }
  }

  if (pendingStateUpdates.size > 0) {
    const committed = commitStates([...pendingStateUpdates.values()]);
    for (const addr of committed) changedAddrs.add(addr);
  }

  return changedAddrs;
}

function recoverInvalidV3LiquidityMutation({
  addr,
  log,
  pool,
  state,
  topic,
  topic0,
  enqueueEnrichment,
  refreshV3,
}: RecoverInvalidV3LiquidityMutationInput) {
  if (topic !== topic0.V3_MINT && topic !== topic0.V3_BURN) return false;

  try {
    validateWatcherStateOrThrow({ ...state, timestamp: Date.now() }, { addr, rawLog: log });
    return false;
  } catch (err) {
    if (!isRecoverableV3LiquidityIntegrityError(err)) return false;
    watcherStateLogger.warn(
      {
        poolAddress: addr,
        blockNumber: Number(log?.blockNumber),
        transactionHash: log?.transactionHash != null ? String(log.transactionHash) : undefined,
        topic0: topic,
        validationReason: errorValidationReason(err, "watcher integrity failure"),
      },
      "Watcher V3 liquidity delta failed integrity; refreshing pool state"
    );
    enqueueEnrichment(addr, () => refreshV3(addr, pool, log));
    return true;
  }
}

function isRecoverableV3LiquidityIntegrityError(err: unknown) {
  const error = err as { name?: unknown; validationReason?: unknown; message?: unknown } | null | undefined;
  if (error?.name !== "WatcherStateIntegrityError") return false;
  const reason = String(error?.validationReason ?? error?.message ?? "");
  return (
    reason === "V3: negative liquidity" ||
    reason.startsWith("V3: negative liquidityGross") ||
    reason.startsWith("V3: invalid liquidityGross") ||
    reason.startsWith("V3: liquidityNet exceeds gross")
  );
}

function decodedValue(decoded: DecodedWatcherLog, section: "indexed" | "body", index: number) {
  return decoded[section]?.[index]?.val;
}

function decodedBigInt(decoded: DecodedWatcherLog, section: "indexed" | "body", index: number) {
  const value = decodedValue(decoded, section, index);
  if (value == null) return 0n;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  ) {
    return BigInt(value);
  }
  return 0n;
}

export function updateV2State(
  state: MutableWatcherState,
  decoded: DecodedWatcherLog,
  pool: WatcherPoolMeta | null = null,
) {
  state.reserve0 = decodedBigInt(decoded, "body", 0);
  state.reserve1 = decodedBigInt(decoded, "body", 1);
  const metadata = parsePoolMetadataValue(pool?.metadata);
  const currentFee = typeof state.fee === "bigint" ? state.fee : null;
  const currentFeeDenominator = typeof state.feeDenominator === "bigint" ? state.feeDenominator : null;
  if (
    currentFee == null ||
    currentFeeDenominator == null ||
    currentFeeDenominator <= 0n ||
    currentFee <= 0n ||
    currentFee >= currentFeeDenominator
  ) {
    const feeDenominator = resolveV2FeeDenominator(metadata);
    state.fee = resolveV2FeeNumerator(metadata, 997n, feeDenominator);
    state.feeDenominator = feeDenominator;
    state.feeSource = metadata?.feeNumerator != null || metadata?.fee != null
      ? "metadata"
      : "default";
  }
}

function ensureV3Fee(state: MutableWatcherState, pool: WatcherPoolMeta | null = null) {
  const currentFee = typeof state.fee === "bigint" ? state.fee : null;
  if (currentFee != null && currentFee >= 0n) return;

  const metadata = parsePoolMetadataValue(pool?.metadata);
  state.fee = resolveV3Fee(metadata);
  state.feeSource = metadata?.fee != null ? "metadata" : "default";
}

export function updateV3SwapState(
  state: MutableWatcherState,
  decoded: DecodedWatcherLog,
  pool: WatcherPoolMeta | null = null,
) {
  state.sqrtPriceX96 = decodedBigInt(decoded, "body", 2);
  state.liquidity = decodedBigInt(decoded, "body", 3);
  state.tick = Number(decodedValue(decoded, "body", 4));
  state.initialized = true;
  ensureV3Fee(state, pool);
}

export function updateV3LiquidityState(
  state: MutableWatcherState,
  decoded: DecodedWatcherLog,
  isMint: boolean,
  pool: WatcherPoolMeta | null = null,
) {
  ensureV3Fee(state, pool);
  const tickLower = Number(decodedValue(decoded, "indexed", 1));
  const tickUpper = Number(decodedValue(decoded, "indexed", 2));
  // Mint body: [sender, amount, amount0, amount1] → amount at index 1
  // Burn body: [amount, amount0, amount1]          → amount at index 0 (no sender)
  const amount = decodedBigInt(decoded, "body", isMint ? 1 : 0);

  if (state.tick != null && state.tick >= tickLower && state.tick < tickUpper) {
    const currentLiquidity = toTickBigInt(state.liquidity);
    if (isMint) state.liquidity = currentLiquidity + amount;
    else state.liquidity = currentLiquidity >= amount ? currentLiquidity - amount : 0n;
  }

  const liquidityGrossDelta = isMint ? amount : -amount;
  updateTickState(state, tickLower, liquidityGrossDelta, isMint ? amount : -amount);
  updateTickState(state, tickUpper, liquidityGrossDelta, isMint ? -amount : amount);
}

export function updateTickState(
  state: MutableWatcherState,
  tick: number,
  liquidityGrossDelta: bigint,
  liquidityNetDelta: bigint,
) {
  state.ticks = normalizeWatcherTicks(state.ticks);
  const data = state.ticks.get(tick) ?? { liquidityGross: 0n, liquidityNet: 0n };

  data.liquidityGross += liquidityGrossDelta;
  data.liquidityNet += liquidityNetDelta;

  if (data.liquidityGross === 0n) state.ticks.delete(tick);
  else state.ticks.set(tick, data);

  state.tickVersion = Number.isFinite(Number(state.tickVersion))
    ? Number(state.tickVersion) + 1
    : 1;
}

function cloneWatcherState(state: Record<string, unknown> | undefined) {
  if (!state) return state;
  const cloned: MutableWatcherState = { ...state };
  if (state.ticks != null) {
    cloned.ticks = normalizeWatcherTicks(state.ticks);
  }
  return cloned;
}

function watcherStateIntegrityError(
  reason: string,
  context: WatcherStateIntegrityContext = {},
): WatcherStateIntegrityError {
  const addr = String(context?.addr ?? context?.poolAddress ?? "unknown").toLowerCase();
  const err = new Error(`watcher state integrity failed for ${addr}: ${reason}`) as WatcherStateIntegrityError;
  err.name = "WatcherStateIntegrityError";
  err.poolAddress = addr;
  err.validationReason = reason;
  if (context?.rawLog?.blockNumber != null) err.blockNumber = Number(context.rawLog.blockNumber);
  if (context?.rawLog?.transactionHash != null) err.transactionHash = String(context.rawLog.transactionHash);
  if (context?.rawLog != null) err.topic0 = toTopicArray(context.rawLog)[0] ?? null;
  return err;
}

function validateWatcherStateOrThrow(
  state: MutableWatcherState,
  context: WatcherStateIntegrityContext = {},
) {
  const verdict = validatePoolState(state);
  if (!verdict.valid) {
    if (allowsObservedUnroutableWatcherState(state, verdict.reason)) {
      return;
    }
    throw watcherStateIntegrityError(verdict.reason ?? "invalid watcher state", context);
  }

  if (typeof state.protocol === "string" && state.protocol.includes("V3")) {
    if (state.liquidity == null || state.liquidity < 0n) {
      throw watcherStateIntegrityError("V3: negative liquidity", context);
    }
    if (state.ticks instanceof Map) {
      for (const [tick, data] of state.ticks.entries()) {
        if (data.liquidityGross < 0n) {
          throw watcherStateIntegrityError(`V3: negative liquidityGross at tick ${tick}`, context);
        }
      }
    }
  }
}

function allowsObservedUnroutableWatcherState(state: MutableWatcherState, reason: string | undefined) {
  if (reason === "V3: zero liquidity") {
    return allowsZeroLiquidityWatcherState(state);
  }
  if (reason === "DODO: zero reserves" || reason === "DODO: zero targets") {
    return allowsObservedDodoWatcherState(state);
  }
  return false;
}

function allowsZeroLiquidityWatcherState(state: MutableWatcherState) {
  if (typeof state.protocol !== "string" || !V3_PROTOCOLS().has(state.protocol) || state?.liquidity !== 0n) return false;

  const rerun = validatePoolState({ ...state, liquidity: 1n });
  return rerun.valid;
}

function allowsObservedDodoWatcherState(state: MutableWatcherState) {
  if (typeof state.protocol !== "string" || !DODO_PROTOCOLS.has(state.protocol)) return false;

  const fields = ["baseReserve", "quoteReserve", "baseTarget", "quoteTarget"];
  const observed = fields.map((field) => toObservedBigInt(state?.[field]));
  if (observed.some((value) => value == null || value < 0n)) return false;
  if (!observed.some((value) => value === 0n)) return false;

  const rerun = { ...state };
  for (const field of fields) {
    if (toObservedBigInt(rerun[field]) === 0n) {
      rerun[field] = 1n;
    }
  }
  return validatePoolState(rerun).valid;
}

function toObservedBigInt(value: unknown) {
  if (typeof value === "bigint") return value;
  if (value == null) return null;
  try {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return BigInt(value);
    }
    return BigInt(String(value));
  } catch {
    return null;
  }
}

export function mergeWatcherState(
  cache: RouteStateCache,
  addr: string,
  nextState: MutableWatcherState,
) {
  return mergeStateIntoCache(cache, addr, nextState) as MutableWatcherState;
}

export function commitWatcherState(
  cache: RouteStateCache,
  persistState: (addr: string, state: MutableWatcherState, rawLog: HyperSyncRawLog) => unknown,
  addr: string,
  state: MutableWatcherState,
  rawLog: HyperSyncRawLog,
) {
  state.timestamp = Date.now();
  validateWatcherStateOrThrow(state, { addr, rawLog });
  persistState(addr, state, rawLog);
  mergeStateIntoCache(cache, addr, state);
}

export function commitWatcherStatesBatch(
  cache: RouteStateCache,
  persistStates: (states: WatcherPersistedStateUpdate[]) => unknown,
  updates: WatcherStateUpdate[],
) {
  if (!Array.isArray(updates) || updates.length === 0) return [];

  const committed: WatcherPersistedStateUpdate[] = [];
  const nextStates = new Map<string, MutableWatcherState>();
  const committedAt = Date.now();

  for (const update of updates) {
    const addr = update.addr.toLowerCase();
    const state = update?.state;
    if (!addr || !state) continue;
    state.timestamp = committedAt;
    validateWatcherStateOrThrow(state, { addr, rawLog: update?.rawLog });
    committed.push({
      pool_address: addr,
      block: Number(update?.rawLog?.blockNumber ?? 0),
      data: state,
    });
    nextStates.set(addr, state);
  }

  if (committed.length > 0) {
    persistStates(committed);
  }

  for (const [addr, state] of nextStates.entries()) {
    mergeStateIntoCache(cache, addr, state);
  }

  return [...nextStates.keys()];
}

export function persistWatcherState(
  registry: WatcherStateWriter,
  addr: string,
  state: MutableWatcherState,
  rawLog: HyperSyncRawLog | null | undefined,
  fallbackBlock: unknown,
) {
  registry.updatePoolState({
    pool_address: addr,
    block: Number(rawLog?.blockNumber ?? fallbackBlock),
    data: state,
  });
}

function hasPersistedWatcherStateInput(
  state: WatcherPersistedStateInput | null | undefined,
): state is WatcherPersistedStateInput & { pool_address: string; data: MutableWatcherState } {
  return typeof state?.pool_address === "string" && state.pool_address.length > 0 && state.data != null;
}

export function persistWatcherStates(
  registry: WatcherStateBatchWriter,
  states: Array<WatcherPersistedStateInput | null | undefined>,
  fallbackBlock: unknown,
) {
  const normalized = states
    .filter(hasPersistedWatcherStateInput)
    .map((state) => ({
      pool_address: state.pool_address.toLowerCase(),
      block: Number(state.block ?? fallbackBlock),
      data: state.data,
    }));

  if (normalized.length === 0) return;
  registry.batchUpdateStates(normalized);
}

export function reloadWatcherCache(
  registry: Parameters<typeof reloadCacheFromRegistry>[0],
  cache: RouteStateCache,
  pendingEnrichment: Parameters<typeof reloadCacheFromRegistry>[2],
) {
  return reloadCacheFromRegistry(registry, cache, pendingEnrichment);
}
