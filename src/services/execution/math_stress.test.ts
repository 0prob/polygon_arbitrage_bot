import { describe, it, expect } from "vitest";
import { scalePriorityFeeByProfitMargin } from "./gas.ts";

describe("scalePriorityFeeByProfitMargin Edge Cases", () => {
  it("uses multiplier 2.0 exactly at threshold 10 MATIC", () => {
    const fee = 10n * 10n ** 9n; // 10 Gwei
    const threshold = 10n ** 19n; // 10 MATIC
    // Profit = 10 MATIC, multiplier should be 2.0
    const scaled = scalePriorityFeeByProfitMargin(fee, threshold, 5);
    expect(scaled).toBe(fee * 2n);
  });

  it("uses maxMultiplier exactly at threshold 50 MATIC", () => {
    const fee = 10n * 10n ** 9n; // 10 Gwei
    const threshold = 5n * 10n ** 19n; // 50 MATIC
    // Profit = 50 MATIC, multiplier should be max (5)
    const scaled = scalePriorityFeeByProfitMargin(fee, threshold, 5);
    expect(scaled).toBe(fee * 5n);
  });
});
