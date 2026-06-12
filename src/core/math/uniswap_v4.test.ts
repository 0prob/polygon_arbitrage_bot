import { describe, it, expect, afterEach } from "vitest";
import { simulateV4Swap } from "./uniswap_v4.ts";
import { resetV3SimCacheForTests } from "./uniswap_v3.ts";

describe("simulateV4Swap", () => {
  afterEach(() => {
    resetV3SimCacheForTests();
  });

  const baseState = {
    initialized: true,
    sqrtPriceX96: 79228162514264337593543950336n,
    liquidity: 1_000_000_000_000_000_000n,
    tick: 0,
    fee: 3000,
    tickSpacing: 60,
    hooks: "0x0000000000000000000000000000000000000000",
  };

  it("rejects pools with non-zero hooks", () => {
    const r = simulateV4Swap(
      { ...baseState, hooks: "0x0000000000000000000000000000000000000001" },
      1_000_000n,
      true,
    );
    expect(r.rejectedReason).toBe("hooks");
    expect(r.amountOut).toBe(0n);
  });

  it("simulates zero-hook V4 swap using concentrated liquidity math", () => {
    const r = simulateV4Swap(baseState, 1_000_000_000_000_000n, true);
    expect(r.rejectedReason).toBeUndefined();
    expect(r.amountOut).toBeGreaterThan(0n);
    expect(r.gasEstimate).toBeGreaterThan(0);
  });

  it("rejects zero liquidity", () => {
    const r = simulateV4Swap({ ...baseState, liquidity: 0n }, 1000n, true);
    expect(r.rejectedReason).toBe("zero_liquidity");
  });
});
