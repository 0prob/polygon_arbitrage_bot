import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryPoolGraph } from "./pool_graph.ts";
import { BoundedMap } from "../core/utils/bounded_map.ts";
import type { PoolMeta } from "../core/types/pool.ts";
import type { RouteStateCache } from "../core/types/route.ts";

function v2Pool(address: string, t0: string, t1: string): PoolMeta {
  return {
    address: address as `0x${string}`,
    protocol: "QUICKSWAP_V2",
    token0: t0 as `0x${string}`,
    token1: t1 as `0x${string}`,
    tokens: [t0, t1] as `0x${string}`[],
    fee: 30,
  };
}

describe("InMemoryPoolGraph", () => {
  let graph: InMemoryPoolGraph;
  let stateCache: RouteStateCache;

  beforeEach(() => {
    graph = new InMemoryPoolGraph();
    stateCache = new BoundedMap<string, Record<string, unknown>>({ maxSize: 1000, ttlMs: 60_000 });
  });

  it("indexes pools by token for direct pair lookup", () => {
    const wmatic = "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270";
    const usdc = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";
    const pool1 = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const pool2 = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    stateCache.set(pool1, { reserve0: 100n, reserve1: 200n });
    stateCache.set(pool2, { reserve0: 300n, reserve1: 400n });

    graph.bulkSync([v2Pool(pool1, wmatic, usdc), v2Pool(pool2, wmatic, usdc)], stateCache);

    const direct = graph.findDirectPools(wmatic, usdc);
    expect(direct).toHaveLength(2);
    expect(direct[0]?.state?.reserve0).toBe(100n);
  });

  it("patches state without rebuilding index", () => {
    const wmatic = "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270";
    const usdc = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";
    const pool = "0xcccccccccccccccccccccccccccccccccccccccc";

    graph.bulkSync([v2Pool(pool, wmatic, usdc)], stateCache);
    stateCache.set(pool, { reserve0: 999n, reserve1: 888n });
    graph.patchStatesFromCache(stateCache, [pool]);

    expect(graph.getState(pool)?.reserve0).toBe(999n);
    expect(graph.getPoolsForToken(wmatic)).toHaveLength(1);
  });

  it("clearStates nulls entries but keeps meta index", () => {
    const wmatic = "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270";
    const usdc = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";
    const pool = "0xdddddddddddddddddddddddddddddddddddddddd";
    stateCache.set(pool, { reserve0: 1n });
    graph.bulkSync([v2Pool(pool, wmatic, usdc)], stateCache);
    graph.clearStates();
    expect(graph.getState(pool)).toBeNull();
    expect(graph.getPoolsForToken(wmatic)).toHaveLength(1);
  });
});
