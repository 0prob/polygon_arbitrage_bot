import { type PublicClient, getContract } from "viem";
import type { Address } from "../../core/types/common.ts";

const V2_FACTORY_ABI = [
  {
    type: "function",
    name: "allPairsLength",
    inputs: [],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "allPairs",
    inputs: [{ type: "uint256" }],
    outputs: [{ type: "address" }],
    stateMutability: "view",
  },
] as const;

const V2_POOL_ABI = [
  {
    type: "function",
    name: "token0",
    inputs: [],
    outputs: [{ type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "token1",
    inputs: [],
    outputs: [{ type: "address" }],
    stateMutability: "view",
  },
] as const;

export interface V2PoolInfo {
  poolAddress: Address;
  token0: Address;
  token1: Address;
}

export async function fetchV2Pools(client: PublicClient, factoryAddress: Address, protocolLabel: string): Promise<V2PoolInfo[]> {
  const factory = getContract({ address: factoryAddress, abi: V2_FACTORY_ABI, client });
  let poolCount: number;
  try {
    poolCount = Number(await factory.read.allPairsLength());
  } catch {
    throw new Error(`V2Discovery[${protocolLabel}]: failed to read allPairsLength from ${factoryAddress}`);
  }

  const chunkSize = 50;
  const pools: V2PoolInfo[] = [];

  for (let start = 0; start < poolCount; start += chunkSize) {
    const end = Math.min(start + chunkSize, poolCount);
    const batch = await Promise.all(
      Array.from({ length: end - start }, async (_, i) => {
        const idx = start + i;
        try {
          const poolAddress = (await factory.read.allPairs([BigInt(idx)])) as Address;
          const pool = getContract({ address: poolAddress, abi: V2_POOL_ABI, client });
          const [token0, token1] = await Promise.all([
            pool.read.token0() as Promise<Address>,
            pool.read.token1() as Promise<Address>,
          ]);
          return { poolAddress, token0, token1 };
        } catch {
          return null;
        }
      }),
    );
    for (const p of batch) {
      if (p) pools.push(p);
    }
  }
  return pools;
}
