import { encodeEventTopics, parseAbiItem } from "viem";
import type { AbiEvent } from "viem";

const topic0Cache = new Map<string, string>();

export function normalizeTopic(topic: unknown) {
  const value = String(topic ?? "")
    .trim()
    .toLowerCase();
  return /^0x[0-9a-f]{64}$/.test(value) ? value : "";
}

export function topic0ForSignature(signature: string) {
  const normalizedSignature = String(signature ?? "").trim();
  const cached = topic0Cache.get(normalizedSignature);
  if (cached != null) return cached;

  let abiItem: AbiEvent;
  try {
    abiItem = parseAbiItem(normalizedSignature) as AbiEvent;
  } catch (err) {
    console.warn(`[topics] Invalid event signature: "${signature}" — ${err instanceof Error ? err.message : String(err)}`);
    topic0Cache.set(normalizedSignature, "");
    return "";
  }
  let encoded: `0x${string}`;
  try {
    encoded = encodeEventTopics({ abi: [abiItem], eventName: abiItem.name })[0];
  } catch (err) {
    console.warn(
      `[topics] Failed to encode event topics for signature: "${signature}" — ${err instanceof Error ? err.message : String(err)}`,
    );
    topic0Cache.set(normalizedSignature, "");
    return "";
  }
  const topic0 = normalizeTopic(encoded);
  topic0Cache.set(normalizedSignature, topic0);
  return topic0;
}

export function topic0sForSignatures(signatures: string[]) {
  return signatures.map((signature) => topic0ForSignature(signature));
}
