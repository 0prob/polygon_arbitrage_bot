import { parseAbiItem, encodeEventTopics } from "viem";
import type { AbiEvent } from "viem";
import type { Address } from "../../core/types/common.ts";
import type { HyperSyncLogFilter, HyperSyncQuery, HyperSyncFieldSelection } from "./types.ts";

const topic0Cache = new Map<string, string>();
const TOPIC0_CACHE_MAX = 500;

const DEFAULT_LOG_FIELDS = [
  "Address",
  "Data",
  "Topic0",
  "Topic1",
  "Topic2",
  "Topic3",
  "BlockNumber",
  "TransactionHash",
  "LogIndex",
  "TransactionIndex",
];

const DEFAULT_BLOCK_FIELDS = ["Number", "Timestamp"];

function normalizeTopic(topic: unknown): string {
  const value = String(topic ?? "")
    .trim()
    .toLowerCase();
  return /^0x[0-9a-f]{64}$/.test(value) ? value : "";
}

function normalizeEvmAddress(value: unknown): Address | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return null;
  return trimmed.toLowerCase() as Address;
}

function normalizeEventSignature(sig: string): string {
  const trimmed = sig.trim();
  if (/^(event|function)\s/i.test(trimmed)) return trimmed;
  return `event ${trimmed}`;
}

export function computeTopic0(eventSignature: string): string {
  const normalizedSig = normalizeEventSignature(String(eventSignature ?? "").trim());
  const cached = topic0Cache.get(normalizedSig);
  if (cached != null) return cached;

  let abiItem: AbiEvent;
  try {
    abiItem = parseAbiItem(normalizedSig) as AbiEvent;
  } catch {
    topic0Cache.set(normalizedSig, "");
    return "";
  }

  let encoded: `0x${string}`;
  try {
    encoded = encodeEventTopics({ abi: [abiItem], eventName: abiItem.name })[0];
  } catch {
    topic0Cache.set(normalizedSig, "");
    return "";
  }

  const topic0 = normalizeTopic(encoded);
  if (topic0Cache.size >= TOPIC0_CACHE_MAX) {
    const firstKey = topic0Cache.keys().next().value;
    if (firstKey != null) topic0Cache.delete(firstKey);
  }
  topic0Cache.set(normalizedSig, topic0);
  return topic0;
}

export function computeTopic0s(signatures: string[]): string[] {
  return signatures.map((sig) => computeTopic0(sig));
}

function isAddress(a: Address | null): a is Address {
  return a != null;
}

export function normalizeLogFilter(filter: HyperSyncLogFilter): HyperSyncLogFilter {
  if (!filter || typeof filter !== "object") {
    return {};
  }
  const address = Array.isArray(filter?.address) ? filter.address.map((addr) => normalizeEvmAddress(addr)).filter(isAddress) : [];
  const dedupedAddress = [...new Set(address)];

  const topics = Array.isArray(filter?.topics)
    ? filter.topics.map((group) => (Array.isArray(group) ? [...new Set(group.map(normalizeTopic).filter((t) => t.length > 0))] : []))
    : [];

  const lastConstrainedIndex = topics.reduce((last, group, i) => (group.length > 0 ? i : last), -1);

  const trimmedTopics = lastConstrainedIndex >= 0 ? topics.slice(0, lastConstrainedIndex + 1) : [];

  const result: HyperSyncLogFilter = {};
  if (dedupedAddress.length > 0) result.address = dedupedAddress;
  if (trimmedTopics.length > 0) result.topics = trimmedTopics;
  return result;
}

export function buildLogQuery(filters: HyperSyncLogFilter[], fromBlock: number, toBlock?: number, joinMode = 2): HyperSyncQuery {
  const normalizedLogs = filters.map(normalizeLogFilter);

  const fieldSelection: HyperSyncFieldSelection = {
    log: [...DEFAULT_LOG_FIELDS],
    block: [...DEFAULT_BLOCK_FIELDS],
  };

  return {
    fromBlock,
    ...(toBlock != null ? { toBlock } : {}),
    logs: normalizedLogs,
    fieldSelection,
    joinMode,
    maxNumLogs: 5000,
  };
}
