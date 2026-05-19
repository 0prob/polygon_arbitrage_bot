import type { Address } from "../../core/types/common.ts";
import { normalizeProtocolKey } from "../../core/identity.ts";
import type { HyperSyncLog } from "../../infra/hypersync/types.ts";

const PROTOCOL_V2 = normalizeProtocolKey("UNISWAP_V2");
const PROTOCOL_BALANCER = normalizeProtocolKey("BALANCER_V2");
const PROTOCOL_V3 = normalizeProtocolKey("QUICKSWAP_V3");
const PROTOCOL_CURVE = normalizeProtocolKey("CURVE_STABLE");

export interface DecodedPoolEvent {
  protocol: string;
  poolAddress: Address;
  token0?: Address;
  token1?: Address;
  tokens?: Address[];
  additionalParams?: Record<string, unknown>;
}

function extractAddress(hex: string, start: number, end: number): Address | null {
  const chunk = hex.slice(start, end);
  if (chunk.length !== 40) return null;
  return ("0x" + chunk) as Address;
}

function extractAddressFromTopic(topic: string): Address | null {
  if (topic.length < 66) return null;
  const chunk = topic.slice(26);
  if (chunk.length !== 40) return null;
  return ("0x" + chunk) as Address;
}

export function decodePairCreated(log: HyperSyncLog): DecodedPoolEvent | null {
  if (!log.topics || log.topics.length < 3) return null;
  if (log.data.length < 66) return null;
  const poolAddress = extractAddress(log.data, 26, 66);
  const token0 = extractAddressFromTopic(log.topics[1]);
  const token1 = extractAddressFromTopic(log.topics[2]);
  if (!poolAddress || !token0 || !token1) return null;
  return {
    protocol: PROTOCOL_V2,
    poolAddress,
    token0,
    token1,
  };
}

export function decodePoolRegistered(log: HyperSyncLog): DecodedPoolEvent | null {
  if (!log.topics || log.topics.length < 2) return null;
  const poolAddress = extractAddressFromTopic(log.topics[1]);
  if (!poolAddress) return null;
  return {
    protocol: PROTOCOL_BALANCER,
    poolAddress,
  };
}

export function decodePoolDeployed(log: HyperSyncLog): DecodedPoolEvent | null {
  if (!log.topics || log.topics.length < 3) return null;
  const poolAddress = extractAddressFromTopic(log.topics[1]);
  const token0 = extractAddressFromTopic(log.topics[2]);
  const token1 = log.topics[3] ? extractAddressFromTopic(log.topics[3]) : undefined;
  if (!poolAddress || !token0) return null;
  return {
    protocol: PROTOCOL_V3,
    poolAddress,
    token0,
    token1: token1 ?? undefined,
  };
}

export function decodeCurvePoolAdded(log: HyperSyncLog): DecodedPoolEvent | null {
  if (!log.topics || log.topics.length < 2) return null;
  const poolAddress = extractAddressFromTopic(log.topics[1]);
  if (!poolAddress) return null;
  return {
    protocol: PROTOCOL_CURVE,
    poolAddress,
  };
}
