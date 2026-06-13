import { describe, it, expect, vi, beforeEach } from "vitest";
import { refreshCyclePoolsOnHead } from "./head_refresh.ts";
import type { RuntimeContext } from "./boot.ts";

vi.mock("../pipeline/fetcher.ts", () => ({
  fetchMissingPoolState: vi.fn().mockResolvedValue(new Set()),
}));

vi.mock("../pipeline/tick_fetcher.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pipeline/tick_fetcher.ts")>();
  return {
    ...actual,
    fetchTicksForCyclePools: vi.fn().mockResolvedValue(1),
    collectCyclePoolAddresses: vi.fn().mockReturnValue(new Set(["0xpool1"])),
  };
});

describe("refreshCyclePoolsOnHead", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips when no cycles", async () => {
    const { fetchMissingPoolState } = await import("../pipeline/fetcher.ts");
    const ctx = {
      stateRefreshService: { Pools: [{ address: "0xpool1" }] },
      stateClient: {},
      publicClient: {},
      config: { routing: { tickFetchEnabled: true, tickWordRange: 3 } },
      logger: { debug: vi.fn() },
    } as unknown as RuntimeContext;

    await refreshCyclePoolsOnHead(ctx, new Map(), [], 50);
    expect(fetchMissingPoolState).not.toHaveBeenCalled();
  });

  it("refreshes cycle pools on new head", async () => {
    const { fetchMissingPoolState } = await import("../pipeline/fetcher.ts");
    const { fetchTicksForCyclePools } = await import("../pipeline/tick_fetcher.ts");
    const stateCache = new Map();
    const cycles = [
      {
        edges: [{ poolAddress: "0xpool1", protocol: "UNISWAP_V3" }],
        hopCount: 1,
        startToken: "0xtoken",
        logWeight: 0,
        cumulativeFeeBps: 30n,
      },
    ] as any;

    const ctx = {
      stateRefreshService: { Pools: [{ address: "0xpool1" }] },
      stateClient: { multicall: vi.fn() },
      publicClient: { multicall: vi.fn() },
      config: { routing: { tickFetchEnabled: true, tickWordRange: 3 } },
      logger: { debug: vi.fn() },
    } as unknown as RuntimeContext;

    await refreshCyclePoolsOnHead(ctx, stateCache, cycles, 50);
    expect(fetchMissingPoolState).toHaveBeenCalled();
    expect(fetchTicksForCyclePools).toHaveBeenCalled();
  });

  it("syncs routing graph edge stateRef after head refresh", async () => {
    const { fetchMissingPoolState } = await import("../pipeline/fetcher.ts");
    const stateCache = new Map<string, Record<string, unknown>>();
    stateCache.set("0xpool1", { reserve0: 1n, reserve1: 2n });
    const cycles = [
      {
        edges: [{ poolAddress: "0xpool1", protocol: "UNISWAP_V2", tokenIn: "0xaaa", tokenOut: "0xbbb" }],
        hopCount: 1,
        startToken: "0xaaa",
        logWeight: 0,
        cumulativeFeeBps: 30n,
      },
    ] as any;
    const graph = {
      adjacency: new Map([
        ["0xaaa", [{ poolAddress: "0xpool1", tokenIn: "0xaaa", tokenOut: "0xbbb", stateRef: { reserve0: 0n } }]],
      ]),
      poolMeta: new Map([["0xpool1", { address: "0xpool1", tokens: ["0xaaa", "0xbbb"] }]]),
      stateRefs: new Map([["0xpool1", { reserve0: 0n }]]),
      tokens: new Set(["0xaaa", "0xbbb"]),
    };
    const updater = new (await import("../pipeline/graph_incremental.ts")).IncrementalGraphUpdater();
    stateCache.set("0xpool1", { reserve0: 500n, reserve1: 600n });

    const ctx = {
      stateRefreshService: { Pools: [{ address: "0xpool1", tokens: ["0xaaa", "0xbbb"] }] },
      stateClient: {},
      publicClient: {},
      config: { routing: { tickFetchEnabled: false } },
      logger: { debug: vi.fn() },
    } as unknown as RuntimeContext;

    await refreshCyclePoolsOnHead(ctx, stateCache as any, cycles, 50, graph as any, updater);
    expect(fetchMissingPoolState).toHaveBeenCalled();
    expect(graph.stateRefs.get("0xpool1")).toEqual({ reserve0: 500n, reserve1: 600n });
    expect(graph.adjacency.get("0xaaa")![0].stateRef).toEqual({ reserve0: 500n, reserve1: 600n });
  });
});
