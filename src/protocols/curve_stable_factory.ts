/**
 * src/protocols/curve_stable_factory.js — Curve StableSwap Factory definition
 */

import { discoverCurveListedFactory } from "./curve_list_factory.ts";
import {
  decodedBodyString,
  decodedBodyValue,
  decodedEventName,
  decodedValueToString,
  rawLogAddressToString,
  type DecodedEvent,
  type DecodedRawLog,
  type ProtocolDefinition,
} from "./factories.ts";

const ZERO = "0x0000000000000000000000000000000000000000";
const FACTORY_ADDRESS = "0x722272D36ef0Da72FF51c5A65Db7b870E2e8D4ee";

const protocol: ProtocolDefinition = {
  name: "Curve StableSwap Factory",
  address: FACTORY_ADDRESS,
  signatures: [
    "event PlainPoolDeployed(address[4] coins, uint256 A, uint256 fee, address deployer)",
    "event MetaPoolDeployed(address coin, address base_pool, uint256 A, uint256 fee, address deployer)",
  ],
  async discover({ key, registry, chainHeight }) {
    return discoverCurveListedFactory({
      protocolKey: key,
      protocolName: "Curve StableSwap Factory",
      factoryAddress: FACTORY_ADDRESS,
      slotCount: 4,
      registry,
      checkpointBlock: chainHeight,
      metadataForPool: () => ({
        factory: FACTORY_ADDRESS,
        variant: "stable-factory",
      }),
    });
  },
  decode(decoded: DecodedEvent, rawLog?: DecodedRawLog) {
    const coinsOrCoin = decodedBodyValue(decoded, 0) || [];
    const isMeta = decodedEventName(decoded) === "MetaPoolDeployed";
    return {
      pool_address: rawLogAddressToString(rawLog),
      tokens: (Array.isArray(coinsOrCoin) ? coinsOrCoin : [coinsOrCoin])
        .map(decodedValueToString)
        .filter((token): token is string => Boolean(token && token !== ZERO)),
      metadata: {
        A: decodedBodyString(decoded, isMeta ? 2 : 1),
        fee: decodedBodyString(decoded, isMeta ? 3 : 2),
        deployer: decodedBodyString(decoded, isMeta ? 4 : 3),
        variant: isMeta ? "meta" : "plain",
        basePool: isMeta ? decodedBodyString(decoded, 1) : undefined,
      },
    };
  },
};

export default protocol;
