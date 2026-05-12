import { encodeEventTopics, parseAbiItem } from "viem";
import type { AbiEvent } from "viem";

const topic0Cache = new Map<string, string>();

export function normalizeTopic(topic: unknown) {
  const value = String(topic ?? "").trim().toLowerCase();
  return /^0x[0-9a-f]{64}$/.test(value) ? value : "";
}

export function topic0ForSignature(signature: string) {
  const normalizedSignature = String(signature ?? "").trim();
  const cached = topic0Cache.get(normalizedSignature);
  if (cached) return cached;

  const abiItem = parseAbiItem(normalizedSignature) as AbiEvent;
  const topic0 = normalizeTopic(encodeEventTopics({ abi: [abiItem], eventName: abiItem.name })[0]);
  topic0Cache.set(normalizedSignature, topic0);
  return topic0;
}

export function topic0sForSignatures(signatures: string[]) {
  return signatures.map((signature) => topic0ForSignature(signature));
}
