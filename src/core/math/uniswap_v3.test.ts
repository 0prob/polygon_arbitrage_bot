import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { simulateV3Swap, quoteV3 } from "./uniswap_v3.ts";
import { getSqrtRatioAtTick } from "./tick_math.ts";

function makePoolState() {
  return {
    initialized: true,
    sqrtPriceX96: getSqrtRatioAtTick(0),
    tick: 0,
    liquidity: 1_000_000_000_000_000_000n,
    fee: 3000n,
    tickSpacing: 60,
    ticks: new Map([
      [-60, { liquidityGross: 1_000_000_000_000_000_000n, liquidityNet: 1_000_000_000_000_000_000n }],
      [60, { liquidityGross: 1_000_000_000_000_000_000n, liquidityNet: -1_000_000_000_000_000_000n }],
    ]),
  };
}

function poolWithTick(tick: number, liquidity: bigint) {
  const spacing = 60;
  const lower = Math.floor(tick / spacing) * spacing;
  const upper = lower + spacing;
  return {
    initialized: true,
    sqrtPriceX96: getSqrtRatioAtTick(tick),
    tick,
    liquidity,
    fee: 3000n,
    tickSpacing: spacing,
    ticks: new Map([
      [lower, { liquidityGross: liquidity, liquidityNet: liquidity }],
      [upper, { liquidityGross: liquidity, liquidityNet: -liquidity }],
    ]),
  };
}

describe("simulateV3Swap", () => {
  it("returns zero output for empty liquidity", () => {
    const state = {
      initialized: true,
      sqrtPriceX96: getSqrtRatioAtTick(0),
      tick: 0,
      liquidity: 0n,
      fee: 3000n,
      tickSpacing: 60,
      ticks: new Map(),
    };
    const result = simulateV3Swap(state, 1000n, true);
    expect(result.amountOut).toBe(0n);
  });
  it("simulates a swap with active liquidity", () => {
    const result = simulateV3Swap(makePoolState(), 1000n, true);
    expect(result.amountOut).toBeGreaterThan(0n);
    expect(result.gasEstimate).toBeGreaterThan(0);
  });
});

describe("quoteV3", () => {
  it("returns same as simulateV3Swap.amountOut", () => {
    const sim = simulateV3Swap(makePoolState(), 1000n, true);
    const quote = quoteV3(makePoolState(), 1000n, true);
    expect(quote).toBe(sim.amountOut);
  });
});

describe("V3 swap property-based", () => {
  it("property: output is non-negative and less than liquidity", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -100000, max: 100000 }),
        fc.bigInt({ min: 1n, max: 1n << 80n }),
        fc.bigInt({ min: 1n, max: 1n << 64n }),
        (tick, liq, amountIn) => {
          const liquidity = liq + 1_000_000n;
          const amount = (amountIn % liquidity) + 1n;
          const state = poolWithTick(tick, liquidity);
          const result = simulateV3Swap(state, amount, true);
          return result.amountOut >= 0n && result.amountOut < liquidity;
        },
      ),
      { numRuns: 200 },
    );
  });

  it("property: zeroForOne pushes price down, oneForZero pushes price up", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -50000, max: 50000 }),
        fc.bigInt({ min: 1n, max: 1n << 60n }),
        (tick, amountIn) => {
          const liquidity = 1_000_000_000_000_000_000n;
          const amount = (amountIn % 1_000_000_000n) + 1n;
          const state = poolWithTick(tick, liquidity);
          const zeroForOne = simulateV3Swap(state, amount, true);
          const oneForZero = simulateV3Swap(state, amount, false);
          return (
            zeroForOne.sqrtPriceX96After <= state.sqrtPriceX96 &&
            oneForZero.sqrtPriceX96After >= state.sqrtPriceX96
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it("property: gas estimate is always positive", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -100000, max: 100000 }),
        fc.bigInt({ min: 1n, max: 1n << 60n }),
        (tick, amountIn) => {
          const amount = (amountIn % 1_000_000_000n) + 1n;
          const state = poolWithTick(tick, 1_000_000_000_000_000_000n);
          const result = simulateV3Swap(state, amount, true);
          return result.gasEstimate >= 185000;
        },
      ),
      { numRuns: 100 },
    );
  });
});
