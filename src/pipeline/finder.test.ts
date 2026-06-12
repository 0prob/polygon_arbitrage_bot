import { describe, it, expect } from "vitest";
import {
  getDynamicSearchBounds,
  findCyclesBellmanFord,
  applyHopStratifiedCap,
  buildHopBalancedWindow,
  longTailRouteBonus,
} from "./finder.ts";
import type { FoundCycle } from "./types.ts";
import type { Address } from "../core/types/common.ts";

function mockCycle(hops: number, score: number, protocol = "UNISWAP_V2"): FoundCycle {
  const edges = Array.from({ length: hops }, (_, i) => ({
    poolAddress: `0xpool${hops}_${i}_${score}`,
    protocol,
    tokenIn: "0xa" as Address,
    tokenOut: "0xb" as Address,
    zeroForOne: true,
    feeBps: 30n,
  }));
  return {
    startToken: "0xa" as Address,
    edges: edges as FoundCycle["edges"],
    hopCount: hops,
    logWeight: score,
    score,
    cumulativeFeeBps: 30n * BigInt(hops),
  };
}

describe("applyHopStratifiedCap", () => {
  it("guarantees short-hop representation when 5-hop scores dominate", () => {
    const cycles: FoundCycle[] = [];
    for (let i = 0; i < 4000; i++) cycles.push(mockCycle(5, i * 0.001));
    for (let i = 0; i < 200; i++) cycles.push(mockCycle(2, 10 + i * 0.01));

    const capped = applyHopStratifiedCap(cycles, 500);
    const hopDist: Record<number, number> = {};
    for (const c of capped) hopDist[c.hopCount] = (hopDist[c.hopCount] ?? 0) + 1;

    expect(capped.length).toBe(500);
    expect(hopDist[2] ?? 0).toBeGreaterThan(0);
    expect(hopDist[5] ?? 0).toBeGreaterThan(0);
  });
});

describe("buildHopBalancedWindow", () => {
  it("includes multiple hop buckets in rotation window", () => {
    const cycles: FoundCycle[] = [];
    for (let i = 0; i < 100; i++) cycles.push(mockCycle(5, i));
    for (let i = 0; i < 50; i++) cycles.push(mockCycle(2, i));

    const window = buildHopBalancedWindow(cycles, 60, 0);
    const buckets = new Set(window.map((c) => c.hopCount));
    expect(buckets.has(2)).toBe(true);
    expect(buckets.has(5)).toBe(true);
  });
});

describe("longTailRouteBonus", () => {
  it("prefers obscure multi-hop routes", () => {
    const hot = mockCycle(2, 5, "UNISWAP_V3");
    const tail = mockCycle(4, 5, "DODO_V2");
    expect(longTailRouteBonus(tail)).toBeLessThan(longTailRouteBonus(hot));
  });
});

describe("getDynamicSearchBounds", () => {
  const WMATIC = "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270" as Address;
  const USDC = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174" as Address;

  it("calculates bounds for V2 routes based on reserves", () => {
    const cycle: FoundCycle = {
      startToken: WMATIC,
      edges: [
        { poolAddress: "0xpool1", protocol: "UNISWAP_V2", tokenIn: WMATIC, tokenOut: USDC, zeroForOne: true, feeBps: 30n },
        { poolAddress: "0xpool2", protocol: "UNISWAP_V2", tokenIn: USDC, tokenOut: WMATIC, zeroForOne: false, feeBps: 30n },
      ] as any,
      hopCount: 2,
      logWeight: 0,
      cumulativeFeeBps: 60n,
    };

    const stateCache = new Map<string, any>([
      ["0xpool1", { reserve0: 1000n * 10n ** 18n, reserve1: 1000n * 10n ** 6n }],
      ["0xpool2", { reserve0: 2000n * 10n ** 6n, reserve1: 2000n * 10n ** 18n }],
    ]);

    const rates = new Map<string, bigint>([[WMATIC.toLowerCase(), 10n ** 18n]]);

    const bounds = getDynamicSearchBounds(cycle, stateCache, rates);

    // minCapacity = 1000n * 10**18 (pool1 reserve0)
    // low = 1000e18 / 5000 = 0.2e18
    // minTestLow = 1e18 (MIN_TEST_WEI floor, up from 1e16)
    // finalLow = max(0.2e18, 1e18) = 1e18
    // high = 1000e18 / 10 = 100e18
    // Clamped by $50k cap ($50k * 1e36 / 1e18 = 50k * 1e18)
    // high = 50000e18
    // Since 100e18 < 50000e18, high remains 100e18.

    expect(bounds.low).toBe(1_000_000_000_000_000_000n);
    expect(bounds.high).toBe(100_000_000_000_000_000_000n);
  });

  it("calculates bounds for V3 routes based on liquidity", () => {
    const cycle: FoundCycle = {
      startToken: WMATIC,
      edges: [
        { poolAddress: "0xpool1", protocol: "UNISWAP_V3", tokenIn: WMATIC, tokenOut: USDC, zeroForOne: true, feeBps: 5n },
        { poolAddress: "0xpool2", protocol: "UNISWAP_V3", tokenIn: USDC, tokenOut: WMATIC, zeroForOne: false, feeBps: 5n },
      ] as any,
      hopCount: 2,
      logWeight: 0,
      cumulativeFeeBps: 10n,
    };

    const SQRT_PRICE_1 = 1n << 96n; // price = 1.0
    const stateCache = new Map<string, any>([
      ["0xpool1", { liquidity: 1_000_000_000_000_000_000n, sqrtPriceX96: SQRT_PRICE_1 }], // 1e18
      ["0xpool2", { liquidity: 2_000_000_000_000_000_000n, sqrtPriceX96: SQRT_PRICE_1 }], // 2e18
    ]);

    const rates = new Map<string, bigint>([[WMATIC.toLowerCase(), 10n ** 18n]]);

    const bounds = getDynamicSearchBounds(cycle, stateCache, rates);

    // V3 fallback capacity = liq = 1e18 (no sqrtPriceX96 in test state)
    // low = 1e18 / 5000 = 2e14
    // high = 1e18 / 10 = 1e17
    // min economic floor: 1e18 * 1e18 / 1e18 (WMATIC rate) = 1e18
    // finalLow = max(1e18, max(2e14, 1e15)) = 1e18
    // finalHigh = max(1e17, 1e18 + 1) = 1e18 + 1
    expect(bounds.low).toBe(1_000_000_000_000_000_000n);
    expect(bounds.high).toBe(1_000_000_000_000_000_001n);
  });

  it("clamps high bound based on USD cap", () => {
    const cycle: FoundCycle = {
      startToken: WMATIC,
      edges: [{ poolAddress: "0xpool1", protocol: "UNISWAP_V2", tokenIn: WMATIC, tokenOut: USDC, zeroForOne: true, feeBps: 30n }] as any,
      hopCount: 1,
      logWeight: 0,
      cumulativeFeeBps: 30n,
    };

    // Huge liquidity: 1M WMATIC
    const stateCache = new Map<string, any>([["0xpool1", { reserve0: 1_000_000n * 10n ** 18n, reserve1: 1_000_000n * 10n ** 6n }]]);

    const rates = new Map<string, bigint>([[WMATIC.toLowerCase(), 10n ** 18n]]);

    // Max cap $1000
    const bounds = getDynamicSearchBounds(cycle, stateCache, rates, 1000);

    // minCapacity = 1,000,000e18
    // high (before clamp) = 100,000e18
    // maxWei = (1000 * 1e18 * 1e18) / 1e18 = 1000e18
    // high (after clamp) = 1000e18

    expect(bounds.high).toBe(1000_000_000_000_000_000_000n);
  });

  it("handles minCapacity <= 0n with fallback", () => {
    const cycle: FoundCycle = {
      startToken: WMATIC,
      edges: [{ poolAddress: "0xpool1", protocol: "UNISWAP_V2", tokenIn: WMATIC, tokenOut: USDC, zeroForOne: true, feeBps: 30n }] as any,
      hopCount: 1,
      logWeight: 0,
      cumulativeFeeBps: 30n,
    };

    // No state, so minCapacity falls through to -1n then to 100n*10n**18
    const stateCache = new Map<string, any>();
    const rates = new Map<string, bigint>();

    const bounds = getDynamicSearchBounds(cycle, stateCache, rates);

    // minCapacity = 100 * 1e18
    // low = 100 * 1e18 / 5000 = 0.02 * 1e18 = 20 * 10^15
    // high = 100 * 1e18 / 10 = 10 * 10^18
    // floorLow = high / 100 = 0.1 * 1e18 = 100 * 10^15
    // finalLow = max(20e15, 100e15) = 100e15

    expect(bounds.low).toBe(100_000_000_000_000_000n);
    expect(bounds.high).toBe(10_000_000_000_000_000_000n);
  });
});

describe("findCyclesBellmanFord", () => {
  const WMATIC = "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270" as Address;
  const USDC = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174" as Address;
  const USDT = "0xc2132d05d31c914a87c6611c10748aeb04b58e8f" as Address;

  it("successfully detects a negative cycle (profitable arbitrage cycle)", async () => {
    const graph: any = {
      adjacency: new Map([
        [
          WMATIC,
          [
            {
              poolAddress: "0xpool1",
              protocol: "UNISWAP_V2",
              tokenIn: WMATIC,
              tokenOut: USDC,
              zeroForOne: true,
              feeBps: 0n,
              tokenInIdx: 0,
              tokenOutIdx: 1,
            } as any,
          ],
        ],
        [
          USDC,
          [
            {
              poolAddress: "0xpool2",
              protocol: "UNISWAP_V2",
              tokenIn: USDC,
              tokenOut: USDT,
              zeroForOne: true,
              feeBps: 0n,
              tokenInIdx: 0,
              tokenOutIdx: 1,
            } as any,
          ],
        ],
        [
          USDT,
          [
            {
              poolAddress: "0xpool3",
              protocol: "UNISWAP_V2",
              tokenIn: USDT,
              tokenOut: WMATIC,
              zeroForOne: true,
              feeBps: 0n,
              tokenInIdx: 0,
              tokenOutIdx: 1,
            } as any,
          ],
        ],
      ]),
      poolMeta: new Map(),
      stateRefs: new Map([
        ["0xpool1", { reserve0: 1000n, reserve1: 1000n }], // ratio = 1.0
        ["0xpool2", { reserve0: 1000n, reserve1: 1000n }], // ratio = 1.0
        ["0xpool3", { reserve0: 1000n, reserve1: 1100n }], // ratio = 1.1
      ]),
      tokens: new Set([WMATIC, USDC, USDT]),
    };

    const cycles = await findCyclesBellmanFord(graph, 3);
    expect(cycles.length).toBeGreaterThan(0);
    const cycle = cycles[0];
    expect(cycle.edges.length).toBe(3);
    const poolAddresses = cycle.edges.map((e) => e.poolAddress);
    expect(poolAddresses).toContain("0xpool1");
    expect(poolAddresses).toContain("0xpool2");
    expect(poolAddresses).toContain("0xpool3");
  });
});
