import type { Address } from "../../core/types/common.ts";
import type { ProtocolKey } from "../../core/identity.ts";
import type { HyperSyncLog } from "../../infra/hypersync/types.ts";

export interface DecodedPoolEvent {
  protocol: ProtocolKey;
  poolAddress: Address;
  token0?: Address;
  token1?: Address;
  tokens?: Address[];
  additionalParams?: Record<string, unknown>;
}

export function decodePairCreated(log: HyperSyncLog): DecodedPoolEvent | null {
  if (!log.topics || log.topics.length < 3) return null;
  return {
    protocol: "UNISWAP_V2" as ProtocolKey,
    poolAddress: ("0x" + log.data.slice(26, 66)) as Address,
    token0: ("0x" + log.topics[1].slice(26)) as Address,
    token1: ("0x" + log.topics[2].slice(26)) as Address,
  };
}

export function decodePoolRegistered(log: HyperSyncLog): DecodedPoolEvent | null {
  if (!log.topics || log.topics.length < 2) return null;
  return {
    protocol: "BALANCER_V2" as ProtocolKey,
    poolAddress: ("0x" + log.topics[1].slice(26)) as Address,
  };
}

export function decodePoolDeployed(log: HyperSyncLog): DecodedPoolEvent | null {
  if (!log.topics || log.topics.length < 3) return null;
  return {
    protocol: "QUICKSWAP_V3" as ProtocolKey,
    poolAddress: ("0x" + log.topics[1].slice(26)) as Address,
    token0: ("0x" + log.topics[2].slice(26)) as Address,
    token1: log.topics[3] ? ("0x" + log.topics[3].slice(26)) as Address : undefined,
  };
}

export function decodeCurvePoolAdded(log: HyperSyncLog): DecodedPoolEvent | null {
  if (!log.topics || log.topics.length < 2) return null;
  return {
    protocol: "CURVE_STABLE" as ProtocolKey,
    poolAddress: ("0x" + log.topics[1].slice(26)) as Address,
  };
}
