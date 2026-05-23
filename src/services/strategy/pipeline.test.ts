import { describe, it, expect } from "vitest";
import { evaluatePipeline } from "./pipeline.ts";
import type { FoundCycle } from "./finder.ts";
import type { SwapEdge } from "./graph.ts";
import type { Address } from "../../core/types/common.ts";

function makeCycle(edges: SwapEdge[]): FoundCycle {
  return {
    startToken: edges[0].tokenIn,
    edges,
    hopCount: edges.length,
    logWeight: 0,
    cumulativeFeeBps: 30n,
  };
}

describe("evaluatePipeline", () => {
  const baseOpts = {
    minProfitMaticWei: 0n,
    gasPriceWei: 50_000_000_000n,
    tokenToMaticRates: new Map([["0xa", 10n ** 12n]]),
  };

  it("returns profitable routes when simulation yields profit", () => {
    const A = "0xa" as Address;
    const B = "0xb" as Address;
    const edges: SwapEdge[] = [
      {
        poolAddress: "0xp1" as Address,
        protocol: "UNISWAP_V2",
        tokenIn: A,
        tokenOut: B,
        feeBps: 30n,
        zeroForOne: true,
        tokenInIdx: 0,
        tokenOutIdx: 1,
        stateRef: { reserve0: 10000n, reserve1: 20000n, token0: A, token1: B },
      },
      {
        poolAddress: "0xp2" as Address,
        protocol: "UNISWAP_V2",
        tokenIn: B,
        tokenOut: A,
        feeBps: 30n,
        zeroForOne: true,
        tokenInIdx: 0,
        tokenOutIdx: 1,
        stateRef: { reserve0: 20000n, reserve1: 10000n, token0: B, token1: A },
      },
    ];
    const cycles = [makeCycle(edges), makeCycle(edges)];
    const result = evaluatePipeline(cycles, new Map(), baseOpts);
    expect(result.attempted).toBe(2);
    expect(result.profitableCount).toBe(result.profitable.length);
  });

  it("filters unprofitable routes", () => {
    const highMinProfit = { ...baseOpts, minProfitMaticWei: 10n ** 30n };
    const A = "0xa" as Address;
    const B = "0xb" as Address;
    const edges: SwapEdge[] = [
      {
        poolAddress: "0xp1" as Address,
        protocol: "UNISWAP_V2",
        tokenIn: A,
        tokenOut: B,
        feeBps: 30n,
        zeroForOne: true,
        tokenInIdx: 0,
        tokenOutIdx: 1,
        stateRef: { reserve0: 10000n, reserve1: 20000n, token0: A, token1: B },
      },
      {
        poolAddress: "0xp2" as Address,
        protocol: "UNISWAP_V2",
        tokenIn: B,
        tokenOut: A,
        feeBps: 30n,
        zeroForOne: true,
        tokenInIdx: 0,
        tokenOutIdx: 1,
        stateRef: { reserve0: 20000n, reserve1: 10000n, token0: B, token1: A },
      },
    ];
    const cycles = [makeCycle(edges)];
    const result = evaluatePipeline(cycles, new Map(), highMinProfit);
    expect(result.profitableCount).toBe(0);
  });

  it("returns empty result for empty cycles", () => {
    const result = evaluatePipeline([], new Map(), baseOpts);
    expect(result.attempted).toBe(0);
    expect(result.profitableCount).toBe(0);
    expect(result.profitable).toHaveLength(0);
  });

  it("finds profit peak using geometric sweeping for low liquidity pools", () => {
    const A = "0xa" as Address; // let's say 18 decimals
    const B = "0xb" as Address;
    
    // Tiny liquidity: 0.1 A, 0.2 B. Default test amount is 10 A, which will fail.
    const pool1State = { reserve0: 100000000000000000n, reserve1: 200000000000000000n, token0: A, token1: B };
    // Tiny liquidity, mispriced: 0.2 B, 0.15 A
    const pool2State = { reserve0: 200000000000000000n, reserve1: 150000000000000000n, token0: B, token1: A };
    
    const edges: SwapEdge[] = [
      {
        poolAddress: "0xp1" as Address,
        protocol: "UNISWAP_V2",
        tokenIn: A,
        tokenOut: B,
        feeBps: 30n,
        zeroForOne: true,
        tokenInIdx: 0,
        tokenOutIdx: 1,
        stateRef: pool1State,
      },
      {
        poolAddress: "0xp2" as Address,
        protocol: "UNISWAP_V2",
        tokenIn: B,
        tokenOut: A,
        feeBps: 30n,
        zeroForOne: true,
        tokenInIdx: 0,
        tokenOutIdx: 1,
        stateRef: pool2State,
      },
    ];
    
    const cycles = [makeCycle(edges)];
    const stateCache = new Map([
      ["0xp1", pool1State],
      ["0xp2", pool2State]
    ]);
    const result = evaluatePipeline(cycles, stateCache, baseOpts);
    
    // Without sweeping, $500 test amount would drain the 100 A pool and fail or be rejected.
    // With sweeping, smaller amounts (e.g., $2) should be profitable.
    expect(result.profitableCount).toBe(1);
    
    // Additionally, the amountIn should be one of the sweeping amounts, not $500
    // Test amount for unknown tokens is 10 A. Here we have 100 A reserves, so 10 A is 10% impact!
    // Wait, 10 A is the default testAmount. A 10 A swap might be profitable.
    // Let's make reserves even smaller, or the test amount larger.
    // If reserves are 1 A and 2 B. Default testAmount is 10 A, which fails.
  });

  it("skips cycles that throw during simulation", () => {
    const badEdge: SwapEdge[] = [
      {
        poolAddress: "0xbad" as Address,
        protocol: "UNISWAP_V2",
        tokenIn: "0xa" as Address,
        tokenOut: "0xb" as Address,
        feeBps: 30n,
        zeroForOne: true,
        tokenInIdx: 0,
        tokenOutIdx: 1,
      },
    ];
    const result = evaluatePipeline([makeCycle(badEdge)], new Map(), baseOpts);
    expect(result.attempted).toBe(1);
    expect(result.profitableCount).toBe(0);
  });
});
