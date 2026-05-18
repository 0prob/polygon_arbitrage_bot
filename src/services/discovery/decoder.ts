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

const V2_PAIR_CREATED = "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9";
const BAL_POOL_REGISTERED = "0x3c63d46a78b72d3d9b52a0b0c8e1df8a1c0d1f1d";
const CURVE_POOL_ADDED = "0xfc684b9a5f4e6a7c9f8d2a5b6c7d8e9f0a1b2c3d";

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
