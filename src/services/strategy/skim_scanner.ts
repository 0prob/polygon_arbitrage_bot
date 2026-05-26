import { type PublicClient, getContract } from "viem";
import type { Address } from "../../core/types/common.ts";

export const PAIR_ABI = [
  {
    name: "allPairs",
    type: "function",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    name: "allPairsLength",
    type: "function",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    name: "getReserves",
    type: "function",
    inputs: [],
    outputs: [
      { name: "_reserve0", type: "uint112" },
      { name: "_reserve1", type: "uint112" },
      { name: "_blockTimestampLast", type: "uint32" },
    ],
    stateMutability: "view",
  },
  {
    name: "token0",
    type: "function",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    name: "token1",
    type: "function",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
] as const;

export class SkimScanner {
  constructor(
    private client: PublicClient,
    private factoryAddress: Address,
  ) {}

  async getAllPairs(batchSize: number = 500): Promise<Address[]> {
    const factory = getContract({
      address: this.factoryAddress,
      abi: PAIR_ABI, // Using the ABI defined in this file
      client: this.client,
    });
    const length = (await factory.read.allPairsLength()) as bigint;
    const pairs: Address[] = [];
    for (let i = 0n; i < length; i += BigInt(batchSize)) {
      const calls = [];
      for (let j = 0; j < batchSize && i + BigInt(j) < length; j++) {
        calls.push(factory.read.allPairs([i + BigInt(j)]));
      }
      const results = await Promise.all(calls);
      pairs.push(...(results as Address[]));
    }
    return pairs;
  }

  async checkPoolForImbalance(_pairAddress: Address) {
    // Implement balance vs reserve check
  }

  async start(_intervalMs: number) {
    // Implement loop
  }
}
