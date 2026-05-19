import { parseAbiItem, encodeEventTopics } from "viem";
import type { Address } from "../../core/types/common.ts";
import type { HyperSyncQuery } from "../../infra/hypersync/types.ts";

const POOL_CREATED_EVENT = "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)";
const POOL_CREATED_TOPIC0 = encodeEventTopics({ abi: [parseAbiItem(POOL_CREATED_EVENT)], eventName: "PoolCreated" })[0];

export interface V3PoolInfo {
  poolAddress: Address;
  token0: Address;
  token1: Address;
  fee: number;
  tickSpacing: number;
}

export async function discoverV3Pools(
  client: { get: <T>(query: unknown) => Promise<T> },
  factoryAddresses: Address[],
): Promise<V3PoolInfo[]> {
  const pools: V3PoolInfo[] = [];

  for (const factory of factoryAddresses) {
    const query: HyperSyncQuery = {
      fromBlock: 0,
      logs: [{ address: [factory], topics: [[POOL_CREATED_TOPIC0]] }],
      fieldSelection: { log: ["Data", "Topic0", "Topic1", "Topic2", "Topic3", "BlockNumber"], block: [] },
      joinMode: 2,
      maxNumLogs: 50000,
    };

    try {
      const response = await client.get<{ data?: { logs?: Array<{ data: string; topics: string[] }> } }>(query);
      const logs = response?.data?.logs ?? [];
      for (const log of logs) {
        const pool = decodePoolCreated(log);
        if (pool) pools.push(pool);
      }
    } catch {
      continue;
    }
  }
  return pools;
}

function extractAddress(hex: string, start: number, end: number): Address | null {
  const chunk = hex.slice(start, end);
  if (chunk.length !== 40) return null;
  return ("0x" + chunk) as Address;
}

function decodePoolCreated(log: { data: string; topics: string[] }): V3PoolInfo | null {
  if (!log.topics || log.topics.length < 4) return null;
  const token0 = ("0x" + log.topics[1].slice(26)) as Address;
  const token1 = ("0x" + log.topics[2].slice(26)) as Address;
  const fee = Number(BigInt(log.topics[3]));
  if (!token0 || !token1 || !Number.isInteger(fee)) return null;
  const poolAddress = extractAddress(log.data, 26, 66);
  if (!poolAddress) return null;
  const feeBytes = log.data.slice(66, 70);
  const tickSpacing = feeBytes ? Number(BigInt("0x" + feeBytes)) : 60;
  return { poolAddress, token0, token1, fee, tickSpacing };
}
