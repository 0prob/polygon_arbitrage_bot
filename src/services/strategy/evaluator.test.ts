import { describe, it, expect } from "vitest";
import { evaluatePaths, evaluatePathsParallel } from "./evaluator.ts";
import type { FoundCycle } from "./finder.ts";
import type { SwapEdge } from "./graph.ts";
import type { Address } from "../../core/types/common.ts";

function makeCycle(edges: SwapEdge[]): FoundCycle {
  return {
    startToken: edges[0].tokenIn,
    edges,
    hopCount: edges.length,
    logWeight: edges.length * -0.03,
    cumulativeFeeBps: BigInt(edges.length) * 30n,
  };
}

describe("evaluatePaths", () => {
  it("returns results for valid paths", () => {
    const A = "0xa" as Address;
    const B = "0xb" as Address;
    const p1 = "0xp1" as Address;
    const p2 = "0xp2" as Address;
    const edges: SwapEdge[] = [
      { poolAddress: p1, protocol: "UNISWAP_V2", tokenIn: A, tokenOut: B, feeBps: 30n, stateRef: { reserve0: 10000n, reserve1: 20000n, token0: A, token1: B } },
      { poolAddress: p2, protocol: "UNISWAP_V2", tokenIn: B, tokenOut: A, feeBps: 30n, stateRef: { reserve0: 20000n, reserve1: 10000n, token0: B, token1: A } },
    ];
    const cycles = [makeCycle(edges)];
    const results = evaluatePaths(cycles, new Map(), 1000n);
    expect(results).toHaveLength(1);
    expect(results[0].result.amountOut).toBeGreaterThan(0n);
  });

  it("skips failing paths silently", () => {
    const goodEdges: SwapEdge[] = [
      { poolAddress: "0xp1" as Address, protocol: "UNISWAP_V2", tokenIn: "0xa" as Address, tokenOut: "0xb" as Address, feeBps: 30n, stateRef: { reserve0: 10000n, reserve1: 20000n, token0: "0xa", token1: "0xb" } },
      { poolAddress: "0xp2" as Address, protocol: "UNISWAP_V2", tokenIn: "0xb" as Address, tokenOut: "0xa" as Address, feeBps: 30n, stateRef: { reserve0: 20000n, reserve1: 10000n, token0: "0xb", token1: "0xa" } },
    ];
    const badEdges: SwapEdge[] = [
      { poolAddress: "0xbad" as Address, protocol: "UNISWAP_V2", tokenIn: "0xa" as Address, tokenOut: "0xb" as Address, feeBps: 30n },
    ];
    const cycles = [makeCycle(goodEdges), makeCycle(badEdges)];
    const results = evaluatePaths(cycles, new Map(), 1000n);
    expect(results).toHaveLength(1);
  });

  it("returns empty for empty input", () => {
    const results = evaluatePaths([], new Map(), 1000n);
    expect(results).toHaveLength(0);
  });
});

describe("evaluatePathsParallel", () => {
  it("evaluates with bounded concurrency", async () => {
    const A = "0xa" as Address;
    const B = "0xb" as Address;
    const edges: SwapEdge[] = [
      { poolAddress: "0xp1" as Address, protocol: "UNISWAP_V2", tokenIn: A, tokenOut: B, feeBps: 30n, stateRef: { reserve0: 10000n, reserve1: 20000n, token0: A, token1: B } },
      { poolAddress: "0xp2" as Address, protocol: "UNISWAP_V2", tokenIn: B, tokenOut: A, feeBps: 30n, stateRef: { reserve0: 20000n, reserve1: 10000n, token0: B, token1: A } },
    ];
    const cycles = [makeCycle(edges), makeCycle(edges)];
    const results = await evaluatePathsParallel(cycles, new Map(), 1000n, 2);
    expect(results).toHaveLength(2);
  });
});
