import { describe, it, expect } from "vitest";
import { computeMaticPriceUsd } from "./matic_price.ts";

describe("computeMaticPriceUsd", () => {
  it("derives price from DAI rate", () => {
    const rates = new Map<string, bigint>();
    rates.set("0x8f3cf7ad23cd3cadbd9735aff958023239c6a063", 5n * 10n ** 17n);
    expect(computeMaticPriceUsd(rates)).toBeCloseTo(2, 5);
  });

  it("falls back to default when no stables", () => {
    expect(computeMaticPriceUsd(new Map())).toBe(0.7);
  });
});
