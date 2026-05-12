
/**
 * src/protocols/curve_crypto_factory.js — Curve Crypto Factory definition
 */

import { discoverCurveListedFactory } from "./curve_list_factory.ts";
import {
  decodedBodyString,
  decodedBodyValue,
  decodedValueToString,
  rawLogAddressToString,
  type DecodedEvent,
  type DecodedRawLog,
  type ProtocolDefinition,
} from "./factories.ts";

const FACTORY_ADDRESS = "0xE5De15A9C9bBedb4F5EC13B131E61245f2983A69";

const protocol: ProtocolDefinition = {
  name: "Curve Crypto Factory",
  address: FACTORY_ADDRESS,
  signature:
    "event CryptoPoolDeployed(address token, address[2] coins, uint256 A, uint256 gamma, uint256 mid_fee, uint256 out_fee, uint256 allowed_extra_profit, uint256 fee_gamma, uint256 adjustment_step, uint256 admin_fee, uint256 ma_half_time, uint256 initial_price, address deployer)",
  async discover({ key, registry, chainHeight }) {
    return discoverCurveListedFactory({
      protocolKey: key,
      protocolName: "Curve Crypto Factory",
      factoryAddress: FACTORY_ADDRESS,
      slotCount: 2,
      registry,
      checkpointBlock: chainHeight,
      metadataForPool: () => ({
        factory: FACTORY_ADDRESS,
        variant: "crypto-factory",
      }),
    });
  },
  decode(decoded: DecodedEvent, rawLog?: DecodedRawLog) {
    const coins = decodedBodyValue(decoded, 1) || [];
    return {
      pool_address: rawLogAddressToString(rawLog),
      tokens: (Array.isArray(coins) ? coins : [coins]).map((c) =>
        decodedValueToString(c)
      ),
      metadata: {
        token: decodedBodyString(decoded, 0),
        A: decodedBodyString(decoded, 2),
        gamma: decodedBodyString(decoded, 3),
        mid_fee: decodedBodyString(decoded, 4),
        out_fee: decodedBodyString(decoded, 5),
        allowed_extra_profit: decodedBodyString(decoded, 6),
        fee_gamma: decodedBodyString(decoded, 7),
        adjustment_step: decodedBodyString(decoded, 8),
        admin_fee: decodedBodyString(decoded, 9),
        ma_half_time: decodedBodyString(decoded, 10),
        initial_price: decodedBodyString(decoded, 11),
        deployer: decodedBodyString(decoded, 12),
      },
    };
  },
};

export default protocol;
