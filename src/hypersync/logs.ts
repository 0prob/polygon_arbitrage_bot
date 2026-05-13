import { normalizeEvmAddress } from "../utils/identity.ts";
import { normalizeTopic } from "./topics.ts";

export type HyperSyncRawLog = {
  address?: unknown;
  blockNumber?: unknown;
  blockHash?: unknown;
  transactionHash?: unknown;
  transactionIndex?: unknown;
  logIndex?: unknown;
  topic0?: unknown;
  topic1?: unknown;
  topic2?: unknown;
  topic3?: unknown;
  topics?: unknown;
  data?: unknown;
  removed?: unknown;
};

export type NormalizedHyperSyncLogMeta = {
  address: string | null;
  blockNumber: number | null;
  blockHash: string | null;
  transactionHash: string | null;
  transactionIndex: number | null;
  logIndex: number | null;
  topics: string[];
};

export function normalizeHyperSyncLogInteger(value: unknown) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
}

export function topicArrayFromHyperSyncLog(log: HyperSyncRawLog) {
  const fromTopicArray = Array.isArray(log?.topics) && log.topics.length > 0
    ? log.topics.flatMap((topic: unknown) =>
        Array.isArray(topic) ? topic : [topic],
      ).map(normalizeTopic).filter((topic: string) => topic.length > 0)
    : null;
  if (fromTopicArray && fromTopicArray.length > 0) return fromTopicArray;

  const fromIndividual = [log?.topic0, log?.topic1, log?.topic2, log?.topic3]
    .map(normalizeTopic)
    .filter((topic) => topic.length > 0);
  if (fromIndividual.length > 0) return fromIndividual;

  return fromTopicArray ?? [];
}

export function normalizeHyperSyncLogMeta(log: HyperSyncRawLog): NormalizedHyperSyncLogMeta {
  const transactionHash = typeof log?.transactionHash === "string"
    ? log.transactionHash.trim().toLowerCase()
    : null;
  const blockHash = typeof log?.blockHash === "string"
    ? log.blockHash.trim().toLowerCase()
    : null;
  return {
    address: normalizeEvmAddress(log?.address),
    blockNumber: normalizeHyperSyncLogInteger(log?.blockNumber),
    blockHash: blockHash && /^0x[0-9a-f]+$/.test(blockHash) ? blockHash : null,
    transactionHash: transactionHash && /^0x[0-9a-f]+$/.test(transactionHash) ? transactionHash : null,
    transactionIndex: normalizeHyperSyncLogInteger(log?.transactionIndex),
    logIndex: normalizeHyperSyncLogInteger(log?.logIndex),
    topics: topicArrayFromHyperSyncLog(log),
  };
}

export function hyperSyncLogIdentityKey(log: HyperSyncRawLog) {
  const meta = normalizeHyperSyncLogMeta(log);
  if (meta.transactionHash && meta.logIndex != null) {
    return `${meta.transactionHash}:${meta.logIndex}`;
  }

  if (
    meta.blockNumber != null &&
    meta.transactionIndex != null &&
    meta.logIndex != null &&
    meta.address != null
  ) {
    return `${meta.blockNumber}:${meta.transactionIndex}:${meta.logIndex}:${meta.address}`;
  }

  return null;
}

export function compareHyperSyncLogs(a: HyperSyncRawLog, b: HyperSyncRawLog) {
  const left = normalizeHyperSyncLogMeta(a);
  const right = normalizeHyperSyncLogMeta(b);
  return (
    (left.blockNumber ?? 0) - (right.blockNumber ?? 0) ||
    (left.transactionIndex ?? 0) - (right.transactionIndex ?? 0) ||
    (left.logIndex ?? 0) - (right.logIndex ?? 0) ||
    String(left.address ?? "").localeCompare(String(right.address ?? ""))
  );
}
