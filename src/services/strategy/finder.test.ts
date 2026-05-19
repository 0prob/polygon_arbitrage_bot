import { describe, it, expect } from "vitest";
import { enumerateCycles, routeKeyFromEdges } from "./finder.ts";
import { buildGraph } from "./graph.ts";
import type { PoolMeta } from "../../core/types/pool.ts";
import type { Address } from "../../core/types/common.ts";
import type { SwapEdge } from "./graph.ts";

describe("enumerateCycles", () => {
  it("finds a simple 2-hop cycle", () => {
    const WETH = "0xa" as Address;
    const USDC = "0xb" as Address;
    const pool: PoolMeta = {
      address: "0xpool" as Address,
      protocol: "V2",
      token0: WETH,
      token1: USDC,
      tokens: [WETH, USDC],
      fee: 30,
      status: "active",
    };
    const graph = buildGraph([pool], new Map());
    const cycles = enumerateCycles(graph, 2);
    expect(cycles.length).toBeGreaterThanOrEqual(1);
    expect(cycles[0].hopCount).toBe(2);
  });

  it("finds 3-hop cycles", () => {
    const A = "0xa" as Address,
      B = "0xb" as Address,
      C = "0xc" as Address;
    const p1: PoolMeta = { address: "0xp1" as Address, protocol: "V2", token0: A, token1: B, tokens: [A, B], fee: 30, status: "active" };
    const p2: PoolMeta = { address: "0xp2" as Address, protocol: "V2", token0: B, token1: C, tokens: [B, C], fee: 30, status: "active" };
    const p3: PoolMeta = { address: "0xp3" as Address, protocol: "V2", token0: C, token1: A, tokens: [C, A], fee: 30, status: "active" };
    const graph = buildGraph([p1, p2, p3], new Map());
    const cycles = enumerateCycles(graph, 3);
    expect(cycles.some((c) => c.hopCount === 3)).toBe(true);
  });
});

describe("routeKeyFromEdges", () => {
  it("produces deterministic keys", () => {
    const e1: SwapEdge = {
      poolAddress: "0xabc" as Address,
      protocol: "V2",
      tokenIn: "0x1" as Address,
      tokenOut: "0x2" as Address,
      feeBps: 30n,
    };
    const e2: SwapEdge = {
      poolAddress: "0xdef" as Address,
      protocol: "V2",
      tokenIn: "0x2" as Address,
      tokenOut: "0x1" as Address,
      feeBps: 30n,
    };
    const key = routeKeyFromEdges([e1, e2], "0x1" as Address);
    expect(key).toBeTruthy();
    expect(key).toContain("0xabc");
    expect(routeKeyFromEdges([e1, e2], "0x1" as Address)).toBe(routeKeyFromEdges([e2, e1], "0x1" as Address));
  });
});
