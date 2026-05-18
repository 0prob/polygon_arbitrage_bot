import { parseAbiItem, encodeEventTopics } from "viem";
import type { AbiEvent } from "viem";
import type { Address } from "../../core/types/common.ts";
import type { HyperSyncLogFilter, HyperSyncQuery, HyperSyncFieldSelection } from "./types.ts";

const topic0Cache = new Map<string, string>();

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
  const value = String(topic ?? "").trim().toLowerCase();
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
  const address = Array.isArray(filter?.address)
    ? filter.address.map((addr) => normalizeEvmAddress(addr)).filter(isAddress)
    : [];
  const dedupedAddress = [...new Set(address)];

  const topics = Array.isArray(filter?.topics)
    ? filter.topics.map((group) =>
        Array.isArray(group)
          ? [...new Set(group.map(normalizeTopic).filter((t) => t.length > 0))]
          : [],
      )
    : [];

  const lastConstrained = topics.length - 1;
  const lastConstrainedIndex = lastConstrained >= 0
    ? topics.reduce((last, group, i) => (group.length > 0 ? i : last), -1)
    : -1;

  const trimmedTopics = lastConstrainedIndex >= 0
    ? topics.slice(0, lastConstrainedIndex + 1).map((g) => [...g])
    : [];

  return {
    ...(dedupedAddress.length > 0 ? { address: dedupedAddress } : {}),
    ...(trimmedTopics.length > 0 ? { topics: trimmedTopics } : {}),
  };
}

export function buildLogQuery(
  filters: HyperSyncLogFilter[],
  fromBlock: number,
  toBlock?: number,
): HyperSyncQuery {
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
    joinMode: 2,
    maxNumLogs: 5000,
  };
}
