import type { PublicClient } from "viem";
import { simulateV3Swap } from "../core/math/uniswap_v3.ts";

/** Uniswap V3 QuoterV2 on Polygon */
export const QUOTER_V2_POLYGON = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e" as const;

const QUOTER_V2_ABI = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
    stateMutability: "nonpayable",
  },
] as const;

export interface V3ParitySample {
  pool: string;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  fee: number;
  amountIn: bigint;
  zeroForOne: boolean;
}

export interface V3ParityResult {
  localOut: bigint;
  quoterOut: bigint;
  driftBps: number;
  ok: boolean;
}

export async function compareV3QuoteParity(
  client: PublicClient,
  poolState: Record<string, unknown>,
  sample: V3ParitySample,
  maxDriftBps: number = 50,
): Promise<V3ParityResult> {
  const local = simulateV3Swap(poolState, sample.amountIn, sample.zeroForOne, sample.fee);
  let quoterOut = 0n;
  try {
    quoterOut = await client.readContract({
      address: QUOTER_V2_POLYGON,
      abi: QUOTER_V2_ABI,
      functionName: "quoteExactInputSingle",
      args: [
        {
          tokenIn: sample.tokenIn,
          tokenOut: sample.tokenOut,
          amountIn: sample.amountIn,
          fee: sample.fee,
          sqrtPriceLimitX96: 0n,
        },
      ],
    }) as unknown as bigint;
    if (Array.isArray(quoterOut)) {
      quoterOut = (quoterOut as unknown[])[0] as bigint;
    }
  } catch {
    return { localOut: local.amountOut, quoterOut: 0n, driftBps: 10_000, ok: false };
  }

  const localOut = local.amountOut;
  if (quoterOut === 0n) {
    return { localOut, quoterOut, driftBps: 10_000, ok: localOut === 0n };
  }
  const diff = localOut > quoterOut ? localOut - quoterOut : quoterOut - localOut;
  const driftBps = Number((diff * 10_000n) / quoterOut);
  return { localOut, quoterOut, driftBps, ok: driftBps <= maxDriftBps };
}
