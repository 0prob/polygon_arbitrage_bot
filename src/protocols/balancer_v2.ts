
/**
 * src/protocols/balancer_v2.js — Balancer V2 protocol definition
 */

import { getBalancerTokens } from "../state/enrichment/balancer.ts";
import {
  createRpcTokenProtocol,
  decodedBodyString,
  decodedIndexedString,
  protocolMetadata,
  type DecodedEvent,
} from "./factories.ts";

export default createRpcTokenProtocol({
  name: "Balancer V2",
  address: "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
  startBlock: 0,
  signature:
    "event PoolRegistered(bytes32 indexed poolId, address indexed poolAddress, uint8 specialization)",
  decode(decoded: DecodedEvent) {
    // indexed: [poolId, poolAddress]; body: [specialization]
    return {
      pool_address: decodedIndexedString(decoded, 1),
      tokens: [], // fetched via enrichTokens
      metadata: {
        poolId: decodedIndexedString(decoded, 0),
        specialization: decodedBodyString(decoded, 0),
      },
    };
  },
  async enrichTokens(poolMeta) {
    return getBalancerTokens(protocolMetadata(poolMeta).poolId);
  },
});
