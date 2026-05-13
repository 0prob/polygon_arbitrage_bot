
/**
 * src/protocols/curve_main_registry.js — Curve Main Registry protocol definition
 */

import { getCurveTokens } from "../state/enrichment/curve.ts";
import {
  createRpcTokenProtocol,
  decodedBodyString,
  decodedIndexedString,
  type DecodedEvent,
} from "./factories.ts";

const REGISTRY_ADDRESS = "0x90E00ACe148ca3b23Ac1bC8C240C2a7Dd9c2d7f5";

export default createRpcTokenProtocol({
  name: "Curve Main Registry",
  address: REGISTRY_ADDRESS,
  startBlock: 15000000,
  signature: "event PoolAdded(address indexed pool, bytes rate_method_id)",
  decode(decoded: DecodedEvent) {
    // indexed: [pool]; body: [rate_method_id]
    return {
      pool_address: decodedIndexedString(decoded, 0),
      tokens: [], // fetched via enrichTokens
      metadata: {
        rate_method_id: decodedBodyString(decoded, 0),
      },
    };
  },
  async enrichTokens(poolMeta) {
    return getCurveTokens(poolMeta.pool_address, REGISTRY_ADDRESS);
  },
});
