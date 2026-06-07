import { describe, it, expect } from "vitest";
import { solveV2Optimal, bigintSqrt } from "./uniswap_v2_solver.ts";
import { simulateV2Swap } from "./uniswap_v2.ts";
import type { SimulationEdge } from "../../pipeline/types.ts";

describe("bigintSqrt", () => {
  it("computes exact square root for perfect squares", () => {
    expect(bigintSqrt(0n)).toBe(0n);
    expect(bigintSqrt(1n)).toBe(1n);
    expect(bigintSqrt(4n)).toBe(2n);
    expect(bigintSqrt(100n)).toBe(10n);
    expect(bigintSqrt(10n ** 18n)).toBe(10n ** 9n);
  });

  it("computes floor square root for non-perfect squares", () => {
    expect(bigintSqrt(2n)).toBe(1n);
    expect(bigintSqrt(3n)).toBe(1n);
    expect(bigintSqrt(5n)).toBe(2n);
    expect(bigintSqrt(99n)).toBe(9n);
  });
});

describe("solveV2Optimal", () => {
  it("returns 0n for unprofitable single pool or cycle", () => {
    const edges: SimulationEdge[] = [
      {
        poolAddress: "0xpool1",
        tokenIn: "0xtoken0",
        tokenOut: "0xtoken1",
        protocol: "UNISWAP_V2",
        normalizedProtocol: "V2",
        zeroForOne: true,
        fee: 30n,
        stateRef: { reserve0: 1000n, reserve1: 1000n, fee: 997n, feeDenominator: 1000n },
      },
    ];
    // A single V2 pool is always unprofitable on its own due to fees
    expect(solveV2Optimal(edges)).toBe(0n);
  });

  it("finds correct optimal amount for a profitable 2-hop cycle", () => {
    // Pool 1: 0xtoken0 -> 0xtoken1. Price: token1 is cheap in pool 1 (high reserve0, low reserve1)
    // Pool 2: 0xtoken1 -> 0xtoken0. Price: token1 is expensive in pool 2 (low reserve0, high reserve1)
    const edges: SimulationEdge[] = [
      {
        poolAddress: "0xpool1",
        tokenIn: "0xtoken0",
        tokenOut: "0xtoken1",
        protocol: "UNISWAP_V2",
        normalizedProtocol: "V2",
        zeroForOne: true,
        fee: 30n,
        stateRef: { reserve0: 100000n, reserve1: 50000n, fee: 997n, feeDenominator: 1000n },
      },
      {
        poolAddress: "0xpool2",
        tokenIn: "0xtoken1",
        tokenOut: "0xtoken0",
        protocol: "UNISWAP_V2",
        normalizedProtocol: "V2",
        zeroForOne: false, // token1 -> token0
        fee: 30n,
        stateRef: { reserve0: 100000n, reserve1: 20000n, fee: 997n, feeDenominator: 1000n },
      },
    ];

    const optimalAmount = solveV2Optimal(edges);
    expect(optimalAmount).toBeGreaterThan(0n);

    // Verify it is indeed a peak by comparing profit at optimal vs optimal +/- 100
    const profitAt = (amount: bigint) => {
      const hop1 = simulateV2Swap(edges[0].stateRef, amount, true);
      const hop2 = simulateV2Swap(edges[1].stateRef, hop1.amountOut, false);
      return hop2.amountOut - amount;
    };

    const profitOpt = profitAt(optimalAmount);
    const profitHalf = profitAt(optimalAmount / 2n);

    expect(profitOpt).toBeGreaterThan(0n);
    expect(profitOpt).toBeGreaterThan(profitHalf);
  });
});
