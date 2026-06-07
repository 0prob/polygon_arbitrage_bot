import { describe, it, expect } from "vitest";
import { solveBrentOptimal } from "./hybrid_solver.ts";

describe("solveBrentOptimal", () => {
  it("should find the peak of a simple concave parabola", () => {
    // f(x) = -(x - 500)^2 + 10000
    const evaluate = (x: bigint) => {
      const diff = x - 500n;
      return -(diff * diff) + 10000n;
    };

    const low = 0n;
    const high = 1000n;
    const result = solveBrentOptimal(low, high, evaluate, 10);

    // Should converge very close to 500
    expect(result).toBeGreaterThanOrEqual(498n);
    expect(result).toBeLessThanOrEqual(502n);
  });

  it("should handle a peak at the boundary (high)", () => {
    // f(x) = x
    const evaluate = (x: bigint) => x;

    const low = 0n;
    const high = 1000n;
    const result = solveBrentOptimal(low, high, evaluate, 10);

    expect(result).toBe(1000n);
  });

  it("should handle a peak at the boundary (low)", () => {
    // f(x) = -x
    const evaluate = (x: bigint) => -x;

    const low = 0n;
    const high = 1000n;
    const result = solveBrentOptimal(low, high, evaluate, 10);

    expect(result).toBe(0n);
  });

  it("should handle complex noisy shapes", () => {
    // A parabolic curve with some minor local features but general peak at 750
    const evaluate = (x: bigint) => {
      const diff = x - 750n;
      const base = -(diff * diff) + 500000n;
      // Add a small sinus feature
      const sinOffset = BigInt(Math.floor(Math.sin(Number(x) / 10) * 100));
      return base + sinOffset;
    };

    const low = 100n;
    const high = 2000n;
    const result = solveBrentOptimal(low, high, evaluate, 12);

    expect(result).toBeGreaterThanOrEqual(740n);
    expect(result).toBeLessThanOrEqual(760n);
  });
});
