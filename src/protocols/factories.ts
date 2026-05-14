import { discoverCurveListedFactory } from "./curve_list_factory.ts";

const EMPTY_METADATA = Object.freeze({});

type DecodedValueWrapper = {
  val?: unknown;
};

export type DecodedEvent = {
  indexed?: unknown[];
  body?: unknown[];
  event?: { name?: unknown };
};

export type DecodedRawLog = {
  address?: unknown;
  [key: string]: unknown;
};

export type DecodeResult = {
  pool_address: string | undefined;
  tokens: Array<string | undefined>;
  metadata: Record<string, unknown>;
};

export type ProtocolCapabilities = {
  discovery: boolean;
  routing: boolean;
  execution: boolean;
};

export type ProtocolDefinition = {
  name: string;
  address: string;
  startBlock?: number;
  signature?: string;
  signatures?: string[];
  decode?: (decoded: DecodedEvent, rawLog?: DecodedRawLog) => DecodeResult;
  enrichTokens?: (poolMeta: Record<string, unknown>) => Promise<string[]>;
  discover?: (context: ProtocolDiscoveryContext) => Promise<ProtocolDiscoveryResult>;
  capabilities?: ProtocolCapabilities;
};

export type ProtocolDiscoveryContext = {
  key: string;
  protocol?: ProtocolDefinition;
  registry: unknown;
  chainHeight?: number | null;
};

export type ProtocolDiscoveryResult = {
  discovered?: number;
  removed?: number;
  checkpointBlock?: number | null;
  rollbackGuard?: Record<string, unknown> | null;
  hydrationPromise?: Promise<number> | null;
};

export function decodedValue(value: unknown) {
  return value && typeof value === "object" && "val" in value ? (value as DecodedValueWrapper).val : value;
}

export function decodedValueToString(value: unknown) {
  return decodedValue(value)?.toString?.();
}

export function decodedIndexedString(decoded: DecodedEvent, index: number) {
  return decodedValueToString(decoded.indexed?.[index]);
}

export function decodedBodyValue(decoded: DecodedEvent, index: number) {
  return decodedValue(decoded.body?.[index]);
}

export function decodedBodyString(decoded: DecodedEvent, index: number) {
  return decodedValueToString(decoded.body?.[index]);
}

export function decodedEventName(decoded: DecodedEvent) {
  return decoded.event?.name == null ? "" : String(decoded.event.name);
}

export function rawLogAddressToString(rawLog: DecodedRawLog | undefined) {
  return rawLog?.address?.toString?.();
}

export function protocolMetadata(poolMeta: Record<string, unknown>) {
  return poolMeta.metadata && typeof poolMeta.metadata === "object" ? (poolMeta.metadata as Record<string, unknown>) : {};
}

export const FULLY_SUPPORTED_CAPABILITIES: ProtocolCapabilities = Object.freeze({
  discovery: true,
  routing: true,
  execution: true,
});

export function createPairCreatedProtocol(
  name: string,
  address: string,
  metadata: Record<string, unknown> = EMPTY_METADATA,
  options: { startBlock?: number } = {},
): ProtocolDefinition {
  return {
    name,
    address,
    ...(Number.isSafeInteger(options.startBlock) && options.startBlock! >= 0 ? { startBlock: options.startBlock } : {}),
    capabilities: FULLY_SUPPORTED_CAPABILITIES,
    signature: "event PairCreated(address indexed token0, address indexed token1, address pair, uint256)",
    decode(decoded: DecodedEvent) {
      return {
        pool_address: decodedBodyString(decoded, 0),
        tokens: [decodedIndexedString(decoded, 0), decodedIndexedString(decoded, 1)],
        metadata,
      };
    },
  };
}

export function createUniV3PoolProtocol(
  name: string,
  address: string,
  metadata: Record<string, unknown> = EMPTY_METADATA,
  capabilities: ProtocolCapabilities = FULLY_SUPPORTED_CAPABILITIES,
  options: { startBlock?: number } = {},
): ProtocolDefinition {
  return {
    name,
    address,
    ...(Number.isSafeInteger(options.startBlock) && options.startBlock! >= 0 ? { startBlock: options.startBlock } : {}),
    capabilities,
    signature: "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)",
    decode(decoded: DecodedEvent) {
      return {
        pool_address: decodedBodyString(decoded, 1),
        tokens: [decodedIndexedString(decoded, 0), decodedIndexedString(decoded, 1)],
        metadata: {
          ...metadata,
          fee: decodedIndexedString(decoded, 2),
          tickSpacing: decodedBodyString(decoded, 0),
        },
      };
    },
  };
}

export function createRpcTokenProtocol({
  name,
  address,
  startBlock,
  signature,
  decode,
  enrichTokens,
  capabilities = FULLY_SUPPORTED_CAPABILITIES,
}: Required<Pick<ProtocolDefinition, "name" | "address" | "signature" | "decode" | "enrichTokens">> & {
  capabilities?: ProtocolCapabilities;
  startBlock?: number;
}): ProtocolDefinition {
  return {
    name,
    address,
    ...(Number.isSafeInteger(startBlock) && startBlock! >= 0 ? { startBlock } : {}),
    signature,
    decode,
    enrichTokens,
    capabilities,
  };
}

type CurveListedFactoryOptions = {
  name: string;
  address: string;
  slotCount?: number;
  dynamicCoins?: boolean;
  metadataForPool?: (poolAddress: string, tokens: string[]) => Record<string, unknown>;
};

export function createCurveListedFactoryProtocol({
  name,
  address,
  slotCount,
  dynamicCoins,
  metadataForPool,
}: CurveListedFactoryOptions): ProtocolDefinition {
  return {
    name,
    address,
    capabilities: FULLY_SUPPORTED_CAPABILITIES,
    async discover({ key, registry, chainHeight }: ProtocolDiscoveryContext) {
      return discoverCurveListedFactory({
        protocolKey: key,
        protocolName: name,
        factoryAddress: address,
        slotCount,
        dynamicCoins,
        registry,
        checkpointBlock: chainHeight,
        metadataForPool,
      });
    },
  };
}
