import { normalizeEvmAddress } from "../utils/pool_record.ts";
import {
  isBalancerProtocol,
  isCurveProtocol,
  isDodoProtocol,
  isWoofiProtocol,
  isV2Protocol,
  isV3Protocol,
  normalizeProtocolKey,
} from "../protocols/classification.ts";
import { toBigInt } from "../utils/bigint.ts";

type JsonRecord = Record<string, unknown>;

type V3TickState = {
  liquidityGross: bigint;
  liquidityNet: bigint;
};

function isRecord(value: unknown): value is JsonRecord {
  return value != null && typeof value === "object";
}

function rowField(row: unknown, field: string) {
  return isRecord(row) ? row[field] : undefined;
}

function stringField(value: unknown, fallback = "") {
  return value == null ? fallback : String(value);
}

function recordField(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

const BIGINT_SCALAR_FIELDS: Record<string, string[]> = {
  V2:      ["fee", "feeDenominator", "reserve0", "reserve1"],
  V3:      ["fee", "sqrtPriceX96", "liquidity"],
  CURVE:   ["fee", "A", "swapFee"],
  BALANCER:["swapFee", "amp", "ampPrecision"],
  DODO:    ["fee", "baseReserve", "quoteReserve", "baseTarget", "quoteTarget", "i", "k", "lpFeeRate", "mtFeeRate"],
  WOOFI:   ["fee", "feeDenominator", "quoteReserve", "quoteFeeRate", "quoteDec"],
};

const BIGINT_ARRAY_FIELDS: Record<string, string[]> = {
  CURVE:   ["balances", "rates"],
  BALANCER:["balances", "weights", "scalingFactors"],
  WOOFI:   ["balances"],
};

function protocolClass(protocol: string): string {
  const protocolKey = normalizeProtocolKey(protocol);
  if (isV2Protocol(protocolKey)) return "V2";
  if (isV3Protocol(protocolKey)) return "V3";
  if (isCurveProtocol(protocolKey)) return "CURVE";
  if (isBalancerProtocol(protocolKey)) return "BALANCER";
  if (isDodoProtocol(protocolKey)) return "DODO";
  if (isWoofiProtocol(protocolKey)) return "WOOFI";
  return "";
}

function toBigIntOrZero(v: unknown): bigint {
  return toBigInt(v, 0n);
}

export function normalizeAddress(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : value;
}

function normalizeAddressList(values: unknown) {
  if (!Array.isArray(values)) return [];
  const addresses: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const address = normalizeEvmAddress(value);
    if (!address || seen.has(address)) continue;
    seen.add(address);
    addresses.push(address);
  }
  return addresses;
}

function tickEntriesFrom(value: unknown): Array<[unknown, unknown]> {
  if (!value) return [];
  if (value instanceof Map) return [...value.entries()];
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (Array.isArray(entry) && entry.length >= 2) return [entry[0], entry[1]] as [unknown, unknown];
        if (isRecord(entry) && ("tick" in entry || "index" in entry)) {
          return [entry.tick ?? entry.index, entry] as [unknown, unknown];
        }
        return null;
      })
      .filter((entry): entry is [unknown, unknown] => entry != null);
  }
  if (typeof value === "object") return Object.entries(value);
  return [];
}

export function rehydrateV3Ticks(ticks: unknown) {
  const entries: Array<[number, V3TickState]> = [];
  for (const [tick, liquidity] of tickEntriesFrom(ticks)) {
    if (!isRecord(liquidity)) continue;
    const tickNumber = Number(tick);
    if (!Number.isInteger(tickNumber)) continue;
    entries.push([tickNumber, {
      liquidityGross: toBigIntOrZero(liquidity?.liquidityGross),
      liquidityNet: toBigIntOrZero(liquidity?.liquidityNet),
    }]);
  }
  entries.sort(([a], [b]) => a - b);
  return new Map(entries);
}

function rehydrateV3State(data: unknown) {
  if (!isRecord(data) || !data.ticks) return;
  data.ticks = rehydrateV3Ticks(data.ticks);
}

function rehydrateWoofiState(data: unknown) {
  if (!isRecord(data) || !isRecord(data.baseTokenStates)) return;
  for (const state of Object.values(data.baseTokenStates)) {
    if (!isRecord(state)) continue;
    for (const field of [
      "reserve",
      "feeRate",
      "maxGamma",
      "maxNotionalSwap",
      "price",
      "spread",
      "coeff",
      "baseDec",
      "quoteDec",
      "priceDec",
    ]) {
      if (state[field] != null) state[field] = toBigInt(state[field]);
    }
  }
}

export function rehydrateStateData(protocol: string, data: unknown): unknown {
  if (!isRecord(data)) return data;
  const cls = protocolClass(protocol);
  for (const field of BIGINT_SCALAR_FIELDS[cls] || []) {
    if (data[field] != null) data[field] = toBigInt(data[field]);
  }
  for (const field of BIGINT_ARRAY_FIELDS[cls] || []) {
    if (Array.isArray(data[field])) {
      data[field] = data[field].map(v => toBigInt(v));
    }
  }
  if (cls === "V3") {
    rehydrateV3State(data);
  } else if (cls === "WOOFI") {
    rehydrateWoofiState(data);
  }
  return data;
}

export function stringifyWithBigInt(obj: unknown) {
  return JSON.stringify(obj, (_key: string, value: unknown) =>
    typeof value === "bigint"
      ? value.toString()
      : value instanceof Map
        ? Object.fromEntries([...value.entries()].map(([key, entry]) => [String(key), entry]))
        : value
  );
}

export function parseJson<T>(value: unknown, fallback: T): unknown {
  if (value == null) return fallback;
  if (typeof value !== "string") return value;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function lowerCaseAddressList(values: unknown = []) {
  return normalizeAddressList(values);
}

export function mapPoolRow(row: unknown) {
  const protocol = String(rowField(row, "protocol") ?? "");
  const address = normalizeAddress(rowField(row, "address"));
  const stateData = rowField(row, "state_data");
  return {
    pool_address: typeof address === "string" ? address : "",
    protocol,
    tokens: normalizeAddressList(parseJson(rowField(row, "tokens"), [])),
    block: rowField(row, "created_block"),
    tx: rowField(row, "created_tx"),
    metadata: parseJson(rowField(row, "metadata"), {}),
    status: stringField(rowField(row, "status"), "active"),
    removed_block: rowField(row, "removed_block") ?? null,
    state: stateData
      ? { block: rowField(row, "last_updated_block"), data: recordField(rehydrateStateData(protocol, parseJson(stateData, null))) }
      : null,
  };
}

export function mapPoolMetaRow(row: unknown) {
  const address = normalizeAddress(rowField(row, "address"));
  return {
    pool_address: typeof address === "string" ? address : "",
    protocol: stringField(rowField(row, "protocol")),
    tokens: normalizeAddressList(parseJson(rowField(row, "tokens"), [])),
    block: rowField(row, "created_block"),
    tx: rowField(row, "created_tx"),
    metadata: parseJson(rowField(row, "metadata"), {}),
    status: stringField(rowField(row, "status"), "active"),
    removed_block: rowField(row, "removed_block") ?? null,
    state: null,
  };
}

export function mapStalePoolRow(row: unknown) {
  const address = normalizeAddress(rowField(row, "address"));
  return {
    pool_address: typeof address === "string" ? address : "",
    protocol: stringField(rowField(row, "protocol")),
    tokens: normalizeAddressList(parseJson(rowField(row, "tokens"), [])),
    metadata: parseJson(rowField(row, "metadata"), {}),
  };
}

export function mapArbHistoryRow(row: unknown) {
  return {
    ...(isRecord(row) ? row : {}),
    tx_hash: normalizeAddress(rowField(row, "tx_hash")),
    start_token: normalizeAddress(rowField(row, "start_token")),
    pools: normalizeAddressList(parseJson(rowField(row, "pools"), [])),
    protocols: parseJson(rowField(row, "protocols"), []),
  };
}
