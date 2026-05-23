import { describe, it, expect } from "vitest";
import { buildGraph } from "./graph.ts";
import type { PoolMeta } from "../../core/types/pool.ts";
import type { Address } from "../../core/types/common.ts";

const WETH = "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619";
const USDC = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";

describe("buildGraph", () => {
  it("builds edges for a two-token pool", () => {
    const pool: PoolMeta = {
      address: "0xpool1" as Address,
      protocol: "UNISWAP_V2",
      token0: WETH as Address,
      token1: USDC as Address,
      tokens: [WETH as Address, USDC as Address],
      fee: 30,
      status: "active",
    };
    const graph = buildGraph([pool], new Map());
    expect(graph.adjacency.size).toBe(2);
    expect(graph.adjacency.get(WETH.toLowerCase())).toHaveLength(1);
    expect(graph.adjacency.get(USDC.toLowerCase())).toHaveLength(1);
  });

  it("uses state cache for refs", () => {
    const state = { reserve0: 100n, reserve1: 200n };
    const stateMap = new Map([["0xpool1", state]]);
    const pool: PoolMeta = {
      address: "0xpool1" as Address,
      protocol: "V2",
      token0: WETH as Address,
      token1: USDC as Address,
      tokens: [WETH as Address, USDC as Address],
      fee: 30,
      status: "active",
    };
    const graph = buildGraph([pool], stateMap);
    expect(graph.stateRefs.get("0xpool1")).toBe(state);
  });

  it("handles pools without tokens field", () => {
    const pool: PoolMeta = {
      address: "0xa" as Address,
      protocol: "V2",
      token0: WETH as Address,
      token1: USDC as Address,
      status: "active",
    };
    const graph = buildGraph([pool], new Map());
    expect(graph.adjacency.size).toBe(0);
  });
});


