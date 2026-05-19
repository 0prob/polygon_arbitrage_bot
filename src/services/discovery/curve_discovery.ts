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
  },
  {
    type: "function",
    name: "pool_list",
    inputs: [{ type: "uint256" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "get_coins",
    inputs: [{ type: "address" }],
    outputs: [{ type: "address[8]" }],
  },
] as const;

export async function fetchCurvePools(client: PublicClient, factoryAddress: Address): Promise<CurvePoolInfo[]> {
  const factory = getContract({ address: factoryAddress, abi: FACTORY_ABI, client });
  const poolCount = Number(await factory.read.pool_count());
  const pools: CurvePoolInfo[] = [];

  for (let i = 0; i < poolCount; i++) {
    const poolAddress = (await factory.read.pool_list([BigInt(i)])) as Address;
    const coins = ((await factory.read.get_coins([poolAddress])) as Address[]).filter(
      (c) => c !== "0x0000000000000000000000000000000000000000",
    );
    pools.push({ poolAddress, lpToken: poolAddress, coins });
  }
  return pools;
}
