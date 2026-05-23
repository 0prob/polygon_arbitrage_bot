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

  it("finds 4-hop cycles starting from hub tokens", () => {
    const WETH = "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619" as Address;
    const A = "0xa" as Address,
      B = "0xb" as Address,
      C = "0xc" as Address;
    const p1: PoolMeta = {
      address: "0xp1" as Address,
      protocol: "V2",
      token0: WETH,
      token1: A,
      tokens: [WETH, A],
      fee: 30,
      status: "active",
    };
    const p2: PoolMeta = { address: "0xp2" as Address, protocol: "V2", token0: A, token1: B, tokens: [A, B], fee: 30, status: "active" };
    const p3: PoolMeta = { address: "0xp3" as Address, protocol: "V2", token0: B, token1: C, tokens: [B, C], fee: 30, status: "active" };
    const p4: PoolMeta = {
      address: "0xp4" as Address,
      protocol: "V2",
      token0: C,
      token1: WETH,
      tokens: [C, WETH],
      fee: 30,
      status: "active",
    };
    const graph = buildGraph([p1, p2, p3, p4], new Map());
    const cycles = enumerateCycles(graph, 4);
    expect(cycles.some((c) => c.hopCount === 4)).toBe(true);
  });

  it("should not throw stack overflow error with many cycles", () => {
    const adjacency = new Map<string, SwapEdge[]>();
    const numCycles = 30000;
    for (let i = 0; i < numCycles; i++) {
      const tA = `tokenA_${i}` as Address;
      const tB = `tokenB_${i}` as Address;
      const tC = `tokenC_${i}` as Address;

      const e1: SwapEdge = { poolAddress: "pool1" as Address, protocol: "v2", tokenIn: tA, tokenOut: tB, feeBps: 30n, zeroForOne: true, tokenInIdx: 0, tokenOutIdx: 1 };
      const e2: SwapEdge = { poolAddress: "pool2" as Address, protocol: "v2", tokenIn: tB, tokenOut: tC, feeBps: 30n, zeroForOne: true, tokenInIdx: 0, tokenOutIdx: 1 };
      const e3: SwapEdge = { poolAddress: "pool3" as Address, protocol: "v2", tokenIn: tC, tokenOut: tA, feeBps: 30n, zeroForOne: true, tokenInIdx: 0, tokenOutIdx: 1 };

      adjacency.set(tA.toLowerCase(), [e1]);
      adjacency.set(tB.toLowerCase(), [e2]);
      adjacency.set(tC.toLowerCase(), [e3]);
    }

    const graph = {
      adjacency,
      poolMeta: new Map(),
      stateRefs: new Map(),
      tokens: new Set<string>(),
    };

    const cycles = enumerateCycles(graph, 3);
    expect(cycles.length).toBeLessThanOrEqual(100000);
    expect(cycles.length).toBeGreaterThan(0);
  }, 10000);
});

describe("routeKeyFromEdges", () => {
  it("produces deterministic keys", () => {
    const e1: SwapEdge = {
      poolAddress: "0xabc" as Address,
      protocol: "V2",
      tokenIn: "0x1" as Address,
      tokenOut: "0x2" as Address,
      feeBps: 30n,
      zeroForOne: true,
      tokenInIdx: 0,
      tokenOutIdx: 1,
    };
    const e2: SwapEdge = {
      poolAddress: "0xdef" as Address,
      protocol: "V2",
      tokenIn: "0x2" as Address,
      tokenOut: "0x1" as Address,
      feeBps: 30n,
      zeroForOne: true,
      tokenInIdx: 0,
      tokenOutIdx: 1,
    };
    const key = routeKeyFromEdges([e1, e2], "0x1" as Address);
    expect(key).toBeTruthy();
    expect(key).toContain("0xabc");
    expect(routeKeyFromEdges([e1, e2], "0x1" as Address)).toBe(routeKeyFromEdges([e2, e1], "0x1" as Address));
  });
});
