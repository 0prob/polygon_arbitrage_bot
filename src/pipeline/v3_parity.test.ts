import { describe, it, expect, vi } from "vitest";
import { getSqrtRatioAtTick } from "../core/math/tick_math.ts";
import { simulateV3Swap } from "../core/math/uniswap_v3.ts";
import { compareV3QuoteParity } from "./v3_parity.ts";

describe("V3 tick-accurate simulation fixtures", () => {
  it("loaded ticks produce shallow=false for in-range swap", () => {
    const state = {
      initialized: true,
      sqrtPriceX96: getSqrtRatioAtTick(0),
      tick: 0,
      liquidity: 5_000_000_000_000_000_000n,
      fee: 3000n,
      tickSpacing: 60,
      ticks: new Map([
        [-60, { liquidityGross: 5_000_000_000_000_000_000n, liquidityNet: 5_000_000_000_000_000_000n }],
        [60, { liquidityGross: 5_000_000_000_000_000_000n, liquidityNet: -5_000_000_000_000_000_000n }],
      ]),
    };
    const result = simulateV3Swap(state, 1_000_000_000_000_000n, true);
    expect(result.shallow).toBe(false);
    expect(result.amountOut).toBeGreaterThan(0n);
  });

  it("marks shallow when swap exhausts loaded tick range", () => {
    const state = {
      initialized: true,
      sqrtPriceX96: getSqrtRatioAtTick(0),
      tick: 0,
      liquidity: 5_000_000_000_000_000_000n,
      fee: 3000n,
      tickSpacing: 60,
      ticks: new Map([
        [60, { liquidityGross: 5_000_000_000_000_000_000n, liquidityNet: -5_000_000_000_000_000_000n }],
      ]),
    };
    const result = simulateV3Swap(state, 10n ** 24n, false);
    expect(result.shallow === true || result.maxReliableAmountIn < 10n ** 24n).toBe(true);
  });

  it("compareV3QuoteParity flags drift above threshold", async () => {
    const client = {
      readContract: vi.fn().mockResolvedValue(900n),
    };
    const state = {
      initialized: true,
      sqrtPriceX96: getSqrtRatioAtTick(0),
      tick: 0,
      liquidity: 5_000_000_000_000_000_000n,
      fee: 3000n,
    };
    const result = await compareV3QuoteParity(
      client as any,
      state,
      {
        pool: "0xpool",
        tokenIn: "0x0000000000000000000000000000000000000001",
        tokenOut: "0x0000000000000000000000000000000000000002",
        fee: 3000,
        amountIn: 1_000_000n,
        zeroForOne: true,
      },
      50,
    );
    expect(result.localOut).toBeGreaterThan(0n);
    expect(result.ok).toBe(false);
  });
});
