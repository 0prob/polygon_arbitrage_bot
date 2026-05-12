import {
  decodedBodyString,
  decodedIndexedString,
  type DecodedEvent,
  type ProtocolDefinition,
} from "./factories.ts";

const FACTORY_ADDRESS = "0x5F1dddbf348aC2fbe22a163e30F99F9ECE3DD50a";

function feePipsFromBps(value: string | undefined) {
  if (!value) return undefined;
  try {
    return (BigInt(value) * 100n).toString();
  } catch {
    return undefined;
  }
}

const protocol: ProtocolDefinition = {
  name: "KyberSwap Elastic",
  address: FACTORY_ADDRESS,
  startBlock: 0,
  capabilities: {
    discovery: true,
    routing: true,
    execution: true,
  },
  signature:
    "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)",
  decode(decoded: DecodedEvent) {
    const swapFeeBps = decodedIndexedString(decoded, 2);
    return {
      pool_address: decodedBodyString(decoded, 1),
      tokens: [
        decodedIndexedString(decoded, 0),
        decodedIndexedString(decoded, 1),
      ],
      metadata: {
        fee: feePipsFromBps(swapFeeBps),
        swapFeeBps,
        tickSpacing: decodedBodyString(decoded, 0),
        isKyberElastic: true,
      },
    };
  },
};

export default protocol;
