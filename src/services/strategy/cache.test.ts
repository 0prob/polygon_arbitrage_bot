import { describe, it, expect } from "vitest";
import { RouteCache } from "./cache.ts";
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

describe("RouteCache", () => {
  it("update adds entries and stores key/pools", () => {
    const cache = new RouteCache(10);
    const A = "0xa" as Address;
    const edges: SwapEdge[] = [
      { poolAddress: "0xp1" as Address, protocol: "V2", tokenIn: A, tokenOut: "0xb" as Address, feeBps: 30n },
      { poolAddress: "0xp2" as Address, protocol: "V2", tokenIn: "0xb" as Address, tokenOut: A, feeBps: 30n },
    ];
    cache.update([{ path: makeCycle(edges), profit: 100n }]);
    expect(cache.size).toBe(1);
    const all = cache.getAll();
    expect(all[0].key).toBeTruthy();
    expect(all[0].pools).toHaveLength(2);
  });

  it("getByPools returns routes touching changed pools", () => {
    const cache = new RouteCache(10);
    const A = "0xa" as Address;
    const edges1: SwapEdge[] = [
      { poolAddress: "0xp1" as Address, protocol: "V2", tokenIn: A, tokenOut: "0xb" as Address, feeBps: 30n },
      { poolAddress: "0xp2" as Address, protocol: "V2", tokenIn: "0xb" as Address, tokenOut: A, feeBps: 30n },
    ];
    const edges2: SwapEdge[] = [
      { poolAddress: "0xp3" as Address, protocol: "V2", tokenIn: A, tokenOut: "0xc" as Address, feeBps: 30n },
      { poolAddress: "0xp4" as Address, protocol: "V2", tokenIn: "0xc" as Address, tokenOut: A, feeBps: 30n },
    ];
    cache.update([
      { path: makeCycle(edges1), profit: 100n },
      { path: makeCycle(edges2), profit: 200n },
    ]);
    const touched = cache.getByPools(new Set(["0xp1"]));
    expect(touched).toHaveLength(1);
    expect(touched[0].profit).toBe(100n);
  });

  it("prune keeps top N entries by profit", () => {
    const cache = new RouteCache(2);
    const A = "0xa" as Address;
    for (let i = 0; i < 5; i++) {
      cache.update([
        {
          path: makeCycle([
            { poolAddress: `0xp${i}a` as Address, protocol: "V2", tokenIn: A, tokenOut: "0xb" as Address, feeBps: 30n },
            { poolAddress: `0xp${i}b` as Address, protocol: "V2", tokenIn: "0xb" as Address, tokenOut: A, feeBps: 30n },
          ]),
          profit: BigInt(i * 10),
        },
      ]);
    }
    expect(cache.size).toBeLessThanOrEqual(2);
    const all = cache.getAll();
    expect(all.every((e) => e.profit >= 30n)).toBe(true);
  });

  it("clear empties the cache", () => {
    const cache = new RouteCache(10);
    cache.update([
      {
        path: makeCycle([
          { poolAddress: "0xp1" as Address, protocol: "V2", tokenIn: "0xa" as Address, tokenOut: "0xb" as Address, feeBps: 30n },
          { poolAddress: "0xp2" as Address, protocol: "V2", tokenIn: "0xb" as Address, tokenOut: "0xa" as Address, feeBps: 30n },
        ]),
        profit: 100n,
      },
    ]);
    expect(cache.size).toBe(1);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("prune does not shrink below maxSize when under capacity", () => {
    const cache = new RouteCache(100);
    const A = "0xa" as Address;
    cache.update([
      {
        path: makeCycle([
          { poolAddress: "0xp1" as Address, protocol: "V2", tokenIn: A, tokenOut: "0xb" as Address, feeBps: 30n },
          { poolAddress: "0xp2" as Address, protocol: "V2", tokenIn: "0xb" as Address, tokenOut: A, feeBps: 30n },
        ]),
        profit: 1n,
      },
    ]);
    expect(cache.size).toBe(1);
  });
});
