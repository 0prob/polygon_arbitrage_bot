import { type PublicClient, getContract } from "viem";
import type { Address } from "../../core/types/common.ts";
import type { CurvePoolInfo } from "./curve_factory.ts";

// Curve Registry/Factory ABIs (simplified)
const FACTORY_ABI = [
  {
    type: "function",
    name: "pool_count",
    inputs: [],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "pool_list",
    inputs: [{ type: "uint256" }],
    outputs: [{ type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "get_coins",
    inputs: [{ type: "address" }],
    outputs: [{ type: "address[8]" }],
    stateMutability: "view",
  },
] as const;

export async function fetchCurvePools(client: PublicClient, factoryAddress: Address): Promise<CurvePoolInfo[]> {
  const factory = getContract({ address: factoryAddress, abi: FACTORY_ABI, client });
  let poolCount: number;
  try {
    poolCount = Number(await factory.read.pool_count());
  } catch {
    throw new Error(`CurveDiscovery: failed to read pool_count from ${factoryAddress}`);
  }

  const pools: CurvePoolInfo[] = [];

  for (let i = 0; i < poolCount; i++) {
    let poolAddress: Address;
    try {
      poolAddress = (await factory.read.pool_list([BigInt(i)])) as Address;
    } catch {
      continue;
    }
    let coins: Address[];
    try {
      coins = ([...(await factory.read.get_coins([poolAddress]))] as Address[]).filter(
        (c) => c !== "0x0000000000000000000000000000000000000000",
      );
    } catch {
      continue;
    }
    pools.push({ poolAddress, lpToken: poolAddress, coins });
  }
  return pools;
}
