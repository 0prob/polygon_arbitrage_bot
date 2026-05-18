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
    tokenToMaticRate: 10n ** 12n,
  };

  it("returns profitable routes when simulation yields profit", () => {
    const A = "0xa" as Address;
    const B = "0xb" as Address;
    const edges: SwapEdge[] = [
      { poolAddress: "0xp1" as Address, protocol: "UNISWAP_V2", tokenIn: A, tokenOut: B, feeBps: 30n, stateRef: { reserve0: 10000n, reserve1: 20000n, token0: A, token1: B } },
      { poolAddress: "0xp2" as Address, protocol: "UNISWAP_V2", tokenIn: B, tokenOut: A, feeBps: 30n, stateRef: { reserve0: 20000n, reserve1: 10000n, token0: B, token1: A } },
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
      { poolAddress: "0xp1" as Address, protocol: "UNISWAP_V2", tokenIn: A, tokenOut: B, feeBps: 30n, stateRef: { reserve0: 10000n, reserve1: 20000n, token0: A, token1: B } },
      { poolAddress: "0xp2" as Address, protocol: "UNISWAP_V2", tokenIn: B, tokenOut: A, feeBps: 30n, stateRef: { reserve0: 20000n, reserve1: 10000n, token0: B, token1: A } },
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

  it("skips cycles that throw during simulation", () => {
    const badEdge: SwapEdge[] = [
      { poolAddress: "0xbad" as Address, protocol: "UNISWAP_V2", tokenIn: "0xa" as Address, tokenOut: "0xb" as Address, feeBps: 30n },
    ];
    const result = evaluatePipeline([makeCycle(badEdge)], new Map(), baseOpts);
    expect(result.attempted).toBe(1);
    expect(result.profitableCount).toBe(0);
  });
});
