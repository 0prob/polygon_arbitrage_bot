import { buildLogQuery as buildInfraLogQuery } from "../../infra/hypersync/query.ts";
import { toBigInt } from "../../core/utils/bigint.ts";
import { asRecord } from "../../core/utils/errors.ts";
import type {
  DecodedWatcherLog,
  MutableWatcherState,
  V3WatcherTickState,
  WatcherPoolMeta,
  WatcherPersistedStateUpdate,
  WatcherStateUpdate,
  HyperSyncLogLike,
  RouteStateCache,
} from "./types.ts";

const V2_DEFAULT_FEE = 997n;
const V2_DEFAULT_DENOM = 1000n;
const V3_DEFAULT_FEE = 3000n;
const CORE_STATE_KEYS = new Set(["poolId", "protocol", "tokens", "timestamp", "token0", "token1"]);

function toBigIntStrict(value: unknown): bigint {
  if (typeof value === "bigint" || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return BigInt(value as string | number | bigint | boolean);
  }
  throw new Error(`invalid bigint: ${String(value)}`);
}

function asStateRecord(value: unknown): Record<string, unknown> {
  const r = asRecord(value);
  return r;
}

export function parsePoolMetadataValue(value: unknown): Record<string, unknown> {
  try {
    let parsed = value ?? {};
    for (let depth = 0; depth < 3 && typeof parsed === "string"; depth++) {
      parsed = JSON.parse(parsed || "{}");
    }
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function resolveV2FeeDenominator(meta: unknown = {}, fallback = V2_DEFAULT_DENOM): bigint {
  const m = asStateRecord(meta);
  const raw = m.feeDenominator ?? m.fee_denominator;
  if (raw == null) return fallback;
  try { const d = toBigIntStrict(raw); return d > 0n ? d : fallback; } catch { return fallback; }
}

export function resolveV2FeeNumerator(meta: unknown = {}, fallback = V2_DEFAULT_FEE, denominator = resolveV2FeeDenominator(meta)): bigint {
  const m = asStateRecord(meta);
  const raw = m.feeNumerator ?? m.fee;
  if (raw == null) return fallback;
  try { const f = toBigIntStrict(raw); return f > 0n && f < denominator ? f : fallback; } catch { return fallback; }
}

export function resolveV3Fee(meta: unknown = {}, fallback = V3_DEFAULT_FEE): bigint {
  const m = asStateRecord(meta);
  const raw = m.fee;
  if (raw == null) return fallback;
  try { const f = toBigIntStrict(raw); return f >= 0n ? f : fallback; } catch { return fallback; }
}

function validateStateAddress(addr: string): string {
  const s = String(addr).toLowerCase().trim();
  return /^0x[0-9a-f]{40}$/.test(s) ? s : "";
}

export function validatePoolState(input: unknown): { valid: boolean; reason?: string } {
  const state = asRecord(input);
  if (!state) return { valid: false, reason: "null state" };
  const poolId = typeof state.poolId === "string" ? state.poolId : "";
  const protocol = typeof state.protocol === "string" ? state.protocol : "";
  const tokenValues = Array.isArray(state.tokens) ? state.tokens : [];
  if (!poolId) return { valid: false, reason: "missing poolId" };
  if (!protocol) return { valid: false, reason: "missing protocol" };
  if (tokenValues.length < 2) return { valid: false, reason: "fewer than 2 tokens" };
  if (validateStateAddress(poolId) !== poolId) return { valid: false, reason: "invalid poolId" };
  return { valid: true };
}

export function mergeStateIntoCache(cache: RouteStateCache, addr: string, nextState: MutableWatcherState): MutableWatcherState {
  const current = cache.get(addr);
  if (!current) {
    cache.set(addr, nextState);
    return nextState;
  }
  for (const key of Object.keys(current)) {
    if (CORE_STATE_KEYS.has(key)) continue;
    if (!Object.prototype.hasOwnProperty.call(nextState, key)) {
      delete current[key];
    }
  }
  for (const [key, value] of Object.entries(nextState)) {
    current[key] = value;
  }
  return current;
}

function topicArrayFromHyperSyncLog(log: HyperSyncLogLike): string[] {
  if (Array.isArray(log?.topics)) return log.topics.map((t) => String(t ?? ""));
  return [];
}

function decodedValue(decoded: DecodedWatcherLog, section: "indexed" | "body", index: number) {
  return decoded[section]?.[index]?.val;
}

function decodedBigInt(decoded: DecodedWatcherLog, section: "indexed" | "body", index: number): bigint {
  return toBigInt(decodedValue(decoded, section, index));
}

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
  if (typeof value === "object") return Object.entries(value as Record<string, unknown>);
  return [];
}

export function normalizeWatcherTicks(ticks: unknown): Map<number, V3WatcherTickState> {
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

function ensureV3Fee(state: MutableWatcherState, pool: WatcherPoolMeta | null = null) {
  const currentFee = typeof state.fee === "bigint" ? state.fee : null;
  if (currentFee != null && currentFee >= 0n) return;
  const metadata = parsePoolMetadataValue(pool?.metadata);
  state.fee = resolveV3Fee(metadata);
  state.feeSource = metadata?.fee != null ? "metadata" : "default";
}

export function updateV2State(state: MutableWatcherState, decoded: DecodedWatcherLog, pool: WatcherPoolMeta | null = null) {
  state.reserve0 = decodedBigInt(decoded, "body", 0);
  state.reserve1 = decodedBigInt(decoded, "body", 1);
  const metadata = parsePoolMetadataValue(pool?.metadata);
  const currentFee = typeof state.fee === "bigint" ? state.fee : null;
  const currentFeeDenominator = typeof state.feeDenominator === "bigint" ? state.feeDenominator : null;
  if (currentFee == null || currentFeeDenominator == null || currentFeeDenominator <= 0n || currentFee <= 0n || currentFee >= currentFeeDenominator) {
    const feeDenominator = resolveV2FeeDenominator(metadata);
    state.fee = resolveV2FeeNumerator(metadata, 997n, feeDenominator);
    state.feeDenominator = feeDenominator;
    state.feeSource = metadata?.feeNumerator != null || metadata?.fee != null ? "metadata" : "default";
  }
}

export function updateV3SwapState(state: MutableWatcherState, decoded: DecodedWatcherLog, pool: WatcherPoolMeta | null = null) {
  state.sqrtPriceX96 = decodedBigInt(decoded, "body", 2);
  state.liquidity = decodedBigInt(decoded, "body", 3);
  state.tick = Number(decodedValue(decoded, "body", 4));
  state.initialized = true;
  ensureV3Fee(state, pool);
}

export function updateTickState(state: MutableWatcherState, tick: number, liquidityGrossDelta: bigint, liquidityNetDelta: bigint) {
  const ticks = normalizeWatcherTicks(state.ticks as Map<number, { liquidityGross: bigint; liquidityNet: bigint }> | undefined);
  state.ticks = ticks;
  const data = ticks.get(tick) ?? { liquidityGross: 0n, liquidityNet: 0n };
  data.liquidityGross += liquidityGrossDelta;
  data.liquidityNet += liquidityNetDelta;
  if (data.liquidityGross === 0n) ticks.delete(tick);
  else ticks.set(tick, data);
  state.tickVersion = Number.isFinite(Number(state.tickVersion)) ? Number(state.tickVersion) + 1 : 1;
}

export function updateV3LiquidityState(state: MutableWatcherState, decoded: DecodedWatcherLog, isMint: boolean, pool: WatcherPoolMeta | null = null) {
  ensureV3Fee(state, pool);
  const tickLower = Number(decodedValue(decoded, "indexed", 1));
  const tickUpper = Number(decodedValue(decoded, "indexed", 2));
  const amount = decodedBigInt(decoded, "body", isMint ? 1 : 0);
  const st = state.tick as number | undefined;
  if (st != null && st >= tickLower && st < tickUpper) {
    const currentLiquidity = toTickBigInt(state.liquidity);
    if (isMint) state.liquidity = currentLiquidity + amount;
    else state.liquidity = currentLiquidity >= amount ? currentLiquidity - amount : 0n;
  }
  const liquidityGrossDelta = isMint ? amount : -amount;
  updateTickState(state, tickLower, liquidityGrossDelta, isMint ? amount : -amount);
  updateTickState(state, tickUpper, liquidityGrossDelta, isMint ? -amount : amount);
}

export function mergeWatcherState(cache: RouteStateCache, addr: string, nextState: MutableWatcherState): MutableWatcherState {
  return mergeStateIntoCache(cache, addr, nextState);
}

export type WatcherStateIntegrityError = Error & {
  poolAddress: string;
  validationReason: string;
  blockNumber?: number;
  transactionHash?: string;
  topic0?: string | null;
};

function watcherStateIntegrityError(reason: string, context: { addr?: unknown; poolAddress?: unknown; rawLog?: HyperSyncLogLike | null } = {}): WatcherStateIntegrityError {
  const addr = String(context?.addr ?? context?.poolAddress ?? "unknown").toLowerCase();
  const err = new Error(`watcher state integrity failed for ${addr}: ${reason}`) as WatcherStateIntegrityError;
  err.name = "WatcherStateIntegrityError";
  err.poolAddress = addr;
  err.validationReason = reason;
  if (context?.rawLog?.blockNumber != null) err.blockNumber = Number(context.rawLog.blockNumber);
  if (context?.rawLog?.transactionHash != null) err.transactionHash = String(context.rawLog.transactionHash);
  if (context?.rawLog != null) err.topic0 = topicArrayFromHyperSyncLog(context.rawLog)[0] ?? null;
  return err;
}

function validateWatcherStateOrThrow(state: MutableWatcherState, context: { addr?: unknown; rawLog?: HyperSyncLogLike | null } = {}) {
  const verdict = validatePoolState(state);
  if (!verdict.valid) throw watcherStateIntegrityError(verdict.reason ?? "invalid watcher state", context);
  if (typeof state.protocol === "string" && state.protocol.includes("V3")) {
    if ((state.liquidity as bigint | undefined) == null || (state.liquidity as bigint) < 0n) throw watcherStateIntegrityError("V3: negative liquidity", context);
    if (state.ticks instanceof Map) {
      for (const [, data] of state.ticks.entries()) {
        if (data.liquidityGross < 0n) throw watcherStateIntegrityError("V3: negative liquidityGross", context);
      }
    }
  }
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
    if (typeof state.timestamp !== "number" || !Number.isFinite(state.timestamp) || state.timestamp <= 0) {
      state.timestamp = committedAt;
    }
    validateWatcherStateOrThrow(state, { addr, rawLog: update?.rawLog });
    committed.push({ pool_address: addr, block: Number(update?.rawLog?.blockNumber ?? 0), data: state });
    nextStates.set(addr, state);
  }
  if (committed.length > 0) persistStates(committed);
  for (const [addr, state] of nextStates.entries()) {
    mergeStateIntoCache(cache, addr, state);
  }
  return [...nextStates.keys()];
}

export function buildLogQuery(fromBlock: number, addresses: string[]) {
  return buildInfraLogQuery(
    [{ address: addresses as import("../../core/types/common.ts").Address[] }],
    fromBlock,
  );
}
