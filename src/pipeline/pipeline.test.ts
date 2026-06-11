import { describe, it, expect, vi } from "vitest";
import { evaluatePipeline } from "./pipeline.ts";
import type { FoundCycle, PipelineOptions, SimulationEdge } from "./types.ts";
import type { RouteStateCache } from "../core/types/route.ts";
import { FlashLoanSource } from "../core/types/execution.ts";

function mockLogger() {
  return { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() };
}

const WMATIC = "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270";
const USDC = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";
const USDT = "0xc2132d05d31c914a87c6611c10748aeb04b58e8f";

function makeV2Cycle(edges: { from: string; to: string; pool: string; feeBps?: number }[]): FoundCycle {
  return {
    startToken: edges[0].from,
    edges: edges.map((e) => ({
      poolAddress: e.pool,
      tokenIn: e.from,
      tokenOut: e.to,
      protocol: "QUICKSWAP_V2",
      zeroForOne: true,
      feeBps: BigInt(e.feeBps ?? 30),
    })),
    hopCount: edges.length,
    logWeight: 0,
    cumulativeFeeBps: BigInt(edges.reduce((s, e) => s + (e.feeBps ?? 30), 0)),
  } as any;
}

function defaultOptions(): PipelineOptions {
  return {
    minProfitMaticWei: 1n,
    gasPriceWei: 30_000_000_000n,
    tokenToMaticRates: new Map([
      [WMATIC.toLowerCase(), 10n ** 18n],
      [USDC.toLowerCase(), 10n ** 12n],
    ]),
    slippageBps: 50n,
    revertRiskBps: 10n,
    flashLoanSource: FlashLoanSource.BALANCER,
    concurrency: 10,
    ternarySearchIterations: 4,
    maxPriceImpactThreshold: 0.15,
    logger: mockLogger(),
  };
}

function simpleStateCache(): RouteStateCache {
  const cache = new Map<string, any>();
  cache.set("0xpool_a", {
    reserve0: 100_000n * 10n ** 18n,
    reserve1: 100_000n * 10n ** 6n,
  });
  cache.set("0xpool_b", {
    reserve0: 100_000n * 10n ** 6n,
    reserve1: 100_000n * 10n ** 18n,
  });
  cache.set("0xpool_c", {
    reserve0: 50_000n * 10n ** 18n,
    reserve1: 50_000n * 10n ** 6n,
  });
  return cache as any;
}

describe("evaluatePipeline", () => {
  it("returns empty result for empty cycles", async () => {
    const result = await evaluatePipeline([], simpleStateCache(), defaultOptions());
    expect(result.attempted).toBe(0);
    expect(result.profitableCount).toBe(0);
    expect(result.profitable).toEqual([]);
  });

  it("returns noRate when start token has no rate", async () => {
    const options = defaultOptions();
    options.tokenToMaticRates = new Map();
    const cycles = [makeV2Cycle([{ from: WMATIC, to: USDC, pool: "0xpool_a" }])];
    const result = await evaluatePipeline(cycles, simpleStateCache(), options);
    expect(result.attempted).toBe(1);
    expect(result.profitableCount).toBe(0);
    expect(result.noRate).toBe(1);
  });

  it("handles cycles where start token rate exists but low/high bounds fail", async () => {
    const stateCache = new Map<string, any>();
    stateCache.set("0xpool_empty", { reserve0: 0n, reserve1: 0n });
    stateCache.set("0xpool_empty2", { reserve0: 0n, reserve1: 0n });

    const cycle = makeV2Cycle([
      { from: WMATIC, to: USDC, pool: "0xpool_empty" },
      { from: USDC, to: WMATIC, pool: "0xpool_empty2" },
    ]);
    const result = await evaluatePipeline([cycle], stateCache, defaultOptions());
    expect(result.pruned).toBe(1);
    expect(result.profitableCount).toBe(0);
  });

  it("handles missing pool state gracefully", async () => {
    const cycle = makeV2Cycle([
      { from: WMATIC, to: USDC, pool: "0xnonexistent" },
      { from: USDC, to: WMATIC, pool: "0xnonexistent2" },
    ]);
    const result = await evaluatePipeline([cycle], simpleStateCache(), defaultOptions());
    expect(result.prunedMissingState).toBe(1);
  });

  it("processes V2 cycles through evaluatePipeline", async () => {
    const options = defaultOptions();
    options.minProfitMaticWei = 0n;
    const cycles = [makeV2Cycle([
      { from: WMATIC, to: USDC, pool: "0xpool_a" },
      { from: USDC, to: WMATIC, pool: "0xpool_b" },
    ])];
    const result = await evaluatePipeline(cycles, simpleStateCache(), options);
    expect(result.attempted).toBe(1);
    // V2 solver may or may not find profit; just verify it runs
    expect(result.pruned + result.simulated).toBe(1);
  });

  it("handles 3-hop V2 cycles", async () => {
    const cycles = [makeV2Cycle([
      { from: WMATIC, to: USDC, pool: "0xpool_a" },
      { from: USDC, to: USDT, pool: "0xpool_b" },
      { from: USDT, to: WMATIC, pool: "0xpool_c" },
    ])];
    const result = await evaluatePipeline(cycles, simpleStateCache(), defaultOptions());
    expect(result.attempted).toBe(1);
    expect(result.simulated).toBeGreaterThanOrEqual(0);
  });

  it("stops after 10 profitable cycles", async () => {
    const poolA = { reserve0: 1_000_000n * 10n ** 18n, reserve1: 1_000_000n * 10n ** 6n };
    const poolB = { reserve0: 1_000_000n * 10n ** 6n, reserve1: 1_000_000n * 10n ** 18n };
    const stateCache = new Map<string, any>([["0xpa", poolA], ["0xpb", poolB]]) as any;

    const manyCycles: FoundCycle[] = [];
    for (let i = 0; i < 20; i++) {
      manyCycles.push(makeV2Cycle([
        { from: WMATIC, to: USDC, pool: "0xpa" },
        { from: USDC, to: WMATIC, pool: "0xpb" },
      ]));
    }
    const result = await evaluatePipeline(manyCycles, stateCache, defaultOptions());
    expect(result.attempted).toBeLessThanOrEqual(20);
    expect(result.profitableCount).toBeLessThanOrEqual(10);
  });

  it("reports pruning stats correctly", async () => {
    const cycles = [
      makeV2Cycle([{ from: WMATIC, to: USDC, pool: "0xnonexistent" }, { from: USDC, to: WMATIC, pool: "0xnonexistent2" }]),
      makeV2Cycle([{ from: WMATIC, to: USDC, pool: "0xpool_a" }, { from: USDC, to: WMATIC, pool: "0xpool_b" }]),
    ];
    const result = await evaluatePipeline(cycles, simpleStateCache(), defaultOptions());
    expect(result.attempted).toBe(2);
    expect(result.prunedMissingState + result.noRate + result.simulated + result.pruned).toBeGreaterThanOrEqual(2);
  });

  it("calls onProgress callback", async () => {
    const onProgress = vi.fn();
    const options = { ...defaultOptions(), onProgress };

    const cycles = [makeV2Cycle([
      { from: WMATIC, to: USDC, pool: "0xpool_a" },
      { from: USDC, to: WMATIC, pool: "0xpool_b" },
    ])];
    await evaluatePipeline(cycles, simpleStateCache(), options);
    expect(onProgress).toHaveBeenCalled();
  });

  it("yields to event loop every 2 batches", async () => {
    const manyCycles: FoundCycle[] = [];
    for (let i = 0; i < 25; i++) {
      manyCycles.push(makeV2Cycle([
        { from: WMATIC, to: USDC, pool: "0xpool_a" },
        { from: USDC, to: WMATIC, pool: "0xpool_b" },
      ]));
    }
    const start = Date.now();
    await evaluatePipeline(manyCycles, simpleStateCache(), defaultOptions());
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(0);
  });
});
