import { describe, it, expect } from "vitest";
import { IncrementalGraphUpdater, syncGraphStateFromCache } from "./graph_incremental.ts";
import { buildGraph } from "./graph.ts";
import type { RoutingGraph } from "./types.ts";
import type { PoolMeta } from "../core/types/pool.ts";
import type { Address } from "../core/types/common.ts";

function makePool(addr: string, protocol: string, tokens: string[], fee?: number): PoolMeta {
  return {
    address: addr as Address,
    protocol,
    token0: tokens[0] as Address,
    token1: tokens[1] as Address,
    tokens: tokens as Address[],
    fee,
  };
}

function makeGraph(pools: PoolMeta[]): RoutingGraph {
  return buildGraph(pools, new Map());
}

describe("IncrementalGraphUpdater", () => {
  it("shouldFullRebuild returns true at interval", () => {
    const updater = new IncrementalGraphUpdater(3);
    expect(updater.shouldFullRebuild()).toBe(false);
    expect(updater.shouldFullRebuild()).toBe(false);
    expect(updater.shouldFullRebuild()).toBe(true);
    expect(updater.shouldFullRebuild()).toBe(false);
  });

  it("adds new pool to graph", () => {
    const graph = makeGraph([]);
    const updater = new IncrementalGraphUpdater();
    const pool = makePool("0xpool1", "UNISWAP_V2", ["0xaaa", "0xbbb"], 30);
    updater.addNewPool(graph, pool, { reserve0: 100n, reserve1: 200n });
    expect(graph.tokens.size).toBe(2);
    expect(graph.poolMeta.size).toBe(1);
    expect(graph.stateRefs.size).toBe(1);
  });

  it("removes pool from graph", () => {
    const pool = makePool("0xpool1", "UNISWAP_V2", ["0xaaa", "0xbbb"], 30);
    const graph = makeGraph([pool]);
    expect(graph.poolMeta.size).toBe(1);
    const updater = new IncrementalGraphUpdater();
    updater.removePool(graph, "0xpool1");
    expect(graph.poolMeta.size).toBe(0);
    expect(graph.stateRefs.size).toBe(0);
  });

  it("syncGraphStateFromCache updates edge stateRef", () => {
    const pool = makePool("0xpool1", "UNISWAP_V2", ["0xaaa", "0xbbb"], 30);
    const graph = makeGraph([pool]);
    const cache = new Map<string, Record<string, unknown>>();
    cache.set("0xpool1", { reserve0: 999n, reserve1: 888n });
    const updater = new IncrementalGraphUpdater();
    syncGraphStateFromCache(graph, [pool], cache as any, updater);
    expect(graph.stateRefs.get("0xpool1")).toEqual({ reserve0: 999n, reserve1: 888n });
    const edges = graph.adjacency.get("0xaaa") ?? [];
    expect(edges.some((e) => e.poolAddress === "0xpool1" && e.stateRef?.reserve0 === 999n)).toBe(true);
  });
});
