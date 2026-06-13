import { describe, it, expect } from "vitest";
import { resolveSwapAmountIn, computeV2OverlayDeltas } from "./pending-amount.ts";
import { resolveV2Fee, simulateV2Swap } from "../../core/math/uniswap_v2.ts";
import type { DecodedSwap } from "./decoder.ts";

describe("resolveSwapAmountIn", () => {
  const v2Decoded = (amountOut: bigint, zeroForOne: boolean): DecodedSwap => ({
    protocol: "uniswap_v2_pool",
    poolAddress: "0xpool" as `0x${string}`,
    tokenIn: "" as `0x${string}`,
    tokenOut: "" as `0x${string}`,
    amountIn: amountOut,
    zeroForOne,
  });

  it("converts V2 output amount to input using reserves", () => {
    const state = { reserve0: 1_000_000n, reserve1: 2_000_000n, initialized: true };
    expect(resolveSwapAmountIn(v2Decoded(10n, true), state)).toBe(6n);
  });

  it("falls back to raw amount when reserves unavailable", () => {
    expect(resolveSwapAmountIn(v2Decoded(10n, true))).toBe(10n);
  });

  it("passes through V3 exact-input amounts unchanged", () => {
    const decoded: DecodedSwap = {
      protocol: "uniswap_v3_pool",
      poolAddress: "0xpool" as `0x${string}`,
      tokenIn: "" as `0x${string}`,
      tokenOut: "" as `0x${string}`,
      amountIn: 123n * 10n ** 18n,
      zeroForOne: true,
    };
    expect(resolveSwapAmountIn(decoded)).toBe(123n * 10n ** 18n);
  });

  it("computes both reserve deltas for V2 overlay fallback", () => {
    const state = { reserve0: 1_000_000n, reserve1: 2_000_000n, initialized: true };
    const decoded = v2Decoded(10n, true);
    const amountIn = resolveSwapAmountIn(decoded, state);
    const { numerator, denominator } = resolveV2Fee(state, undefined, 1000n);
    const swap = simulateV2Swap(state, amountIn, true, numerator, denominator);
    expect(computeV2OverlayDeltas(decoded, state)).toEqual({
      reserve0: amountIn,
      reserve1: -swap.amountOut,
    });
  });

  it("falls back to single-side overlay delta without reserves", () => {
    expect(computeV2OverlayDeltas(v2Decoded(10n, true))).toEqual({ reserve0: 10n });
  });
});
