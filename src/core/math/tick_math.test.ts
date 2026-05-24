import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { MIN_TICK, MAX_TICK, MIN_SQRT_RATIO, MAX_SQRT_RATIO, getSqrtRatioAtTick, getTickAtSqrtRatio } from "./tick_math.ts";

describe("tick math constants", () => {
  it("MIN_TICK is -887272", () => {
    expect(MIN_TICK).toBe(-887272);
  });
  it("MAX_TICK is 887272", () => {
    expect(MAX_TICK).toBe(887272);
  });
});

describe("getSqrtRatioAtTick", () => {
  it("returns 2^96 at tick 0", () => {
    expect(getSqrtRatioAtTick(0)).toBe(2n ** 96n);
  });
  it("returns MIN_SQRT_RATIO at MIN_TICK", () => {
    expect(getSqrtRatioAtTick(MIN_TICK)).toBe(MIN_SQRT_RATIO);
  });
  it("returns MAX_SQRT_RATIO at MAX_TICK", () => {
    expect(getSqrtRatioAtTick(MAX_TICK)).toBe(MAX_SQRT_RATIO);
  });
  it("throws on tick out of bounds", () => {
    expect(() => getSqrtRatioAtTick(MAX_TICK + 1)).toThrow();
    expect(() => getSqrtRatioAtTick(MIN_TICK - 1)).toThrow();
  });
  it("round-trip with getTickAtSqrtRatio", () => {
    for (const tick of [-100000, -1000, 0, 1000, 100000]) {
      const sqrt = getSqrtRatioAtTick(tick);
      const recovered = getTickAtSqrtRatio(sqrt);
      expect(Math.abs(recovered - tick)).toBeLessThanOrEqual(1);
    }
  });
});

describe("tick math property-based", () => {
  it("property: round-trip preserves tick value within ±1", () => {
    fc.assert(
      fc.property(fc.integer({ min: MIN_TICK + 1, max: MAX_TICK - 1 }), (tick) => {
        const sqrt = getSqrtRatioAtTick(tick);
        const recovered = getTickAtSqrtRatio(sqrt);
        return Math.abs(recovered - tick) <= 1;
      }),
      { numRuns: 500 },
    );
  });

  it("property: sqrt ratio bounds strictly increase with tick", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: MIN_TICK, max: MAX_TICK - 1000 }),
        fc.integer({ min: 100, max: 1000 }),
        (lowTick, offset) => {
          const highTick = lowTick + offset;
          const sqrtLow = getSqrtRatioAtTick(lowTick);
          const sqrtHigh = getSqrtRatioAtTick(highTick);
          return sqrtLow < sqrtHigh;
        },
      ),
      { numRuns: 200 },
    );
  });

  it("property: sqrt ratio within valid range for all ticks", () => {
    fc.assert(
      fc.property(fc.integer({ min: MIN_TICK, max: MAX_TICK }), (tick) => {
        const sqrt = getSqrtRatioAtTick(tick);
        return sqrt >= MIN_SQRT_RATIO && sqrt <= MAX_SQRT_RATIO;
      }),
      { numRuns: 500 },
    );
  });
});
