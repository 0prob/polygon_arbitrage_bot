import { describe, it, expect, vi } from "vitest";
import { invalidateRoutingOnReorg, applyReorgInvalidation } from "./pass_reorg.ts";
import type { PassLoopState } from "./pass_state.ts";
import { InMemoryPoolGraph } from "../pipeline/pool_graph.ts";
import { BoundedMap } from "../core/utils/bounded_map.ts";
import type { RuntimeContext } from "./boot.ts";

function baseState(): PassLoopState {
  return {
    cachedCycles: [{ startToken: "0xa", edges: [], hopCount: 2, logWeight: 0, cumulativeFeeBps: 0n }],
    hasuraPoolsCache: null,
    cachedMetas: null,
    cachedRates: null,
    tokenToMaticRates: new Map(),
    ratesNeedFullRefresh: false,
    pendingFocusTokens: null,
    lastRefreshTime: 1000,
    lastReorgCheck: 0,
    lastStatusWriteTime: 0,
    lastMempoolTraceId: undefined,
    lfEnumerationInFlight: false,
    lastEnumerationTime: 5000,
    lastPoolsFingerprint: "abc",
    cycleWindowStart: Date.now(),
    recentRouteTimestamps: new Map(),
    headTriggered: false,
    lastHeadTime: 0,
    lastTierCheck: 0,
    lfTickInFlight: false,
    maticPriceUsd: 0.7,
    cyclesGeneration: 1,
    hfSnapshot: null,
    hfSimOffset: 42,
    lastEnumStateCacheSize: 100,
    infra: {
      tier: "standard" as const,
      hfBudgetMs: 180,
      maxSimCycles: 500,
      simBatchSize: 50,
      enumMaxPathsCap: 8000,
      enumMaxPathsScale: 1,
      routeCooldownMs: 60_000,
      concurrencyScale: 1,
      dryRunConcurrency: 4,
    },
    hfCycleFilterCache: { generation: 1, quarantineRevision: 0, indices: [0] },
  };
}

describe("invalidateRoutingOnReorg", () => {
  it("clears cached cycles and forces re-enumeration", () => {
    const state = baseState();
    invalidateRoutingOnReorg(state);
    expect(state.cachedCycles).toEqual([]);
    expect(state.lastEnumerationTime).toBe(0);
    expect(state.lastPoolsFingerprint).toBe("");
    expect(state.hfSimOffset).toBe(0);
    expect(state.hfCycleFilterCache).toBeUndefined();
    expect(state.ratesNeedFullRefresh).toBe(true);
    expect(state.oracleRateCache).toBeUndefined();
    expect(state.cyclesGeneration).toBe(2);
    expect(state.hfSnapshot?.cachedCycles).toEqual([]);
  });

  it("applyReorgInvalidation clears state cache and pool graph states", () => {
    const state = baseState();
    const stateCache = new BoundedMap<string, Record<string, unknown>>({ maxSize: 10, ttlMs: 60_000 });
    stateCache.set("0xpool", { reserve0: 1n });
    const poolGraph = new InMemoryPoolGraph();
    poolGraph.syncPool(
      {
        address: "0xpool" as `0x${string}`,
        protocol: "QUICKSWAP_V2",
        token0: "0xa" as `0x${string}`,
        token1: "0xb" as `0x${string}`,
        tokens: ["0xa", "0xb"] as `0x${string}`[],
        fee: 30,
      },
      { reserve0: 1n },
    );

    applyReorgInvalidation(
      {
        stateCache,
        poolGraph,
        logger: { warn: vi.fn() },
      } as unknown as RuntimeContext,
      state,
      "test reorg",
    );

    expect(stateCache.size).toBe(0);
    expect(poolGraph.getState("0xpool")).toBeNull();
  });
});
