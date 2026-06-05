import { describe, it, expect } from "vitest";
import { getDynamicSearchBounds } from "./finder.ts";
import type { FoundCycle } from "./types.ts";
import type { Address } from "../core/types/common.ts";

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

    const stateCache = new Map<string, any>([
      ["0xpool1", { liquidity: 1_000_000_000_000_000_000n }], // 1e18
      ["0xpool2", { liquidity: 2_000_000_000_000_000_000n }], // 2e18
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
