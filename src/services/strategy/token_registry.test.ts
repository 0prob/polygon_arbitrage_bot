import { describe, it, expect } from "vitest";
import { TokenRegistry } from "./token_registry";

describe("TokenRegistry", () => {
  it("applies sell tax correctly", () => {
    const registry = new TokenRegistry({
      "0xTAX": { buyTaxMultiplier: 0.99, sellTaxMultiplier: 0.98 }
    });
    const amount = 1000n;
    expect(registry.applySellTax("0xTAX", amount)).toBe(980n);
    expect(registry.applySellTax("0xCLEAN", amount)).toBe(1000n);
  });

  it("applies buy tax correctly", () => {
    const registry = new TokenRegistry({
      "0xTAX": { buyTaxMultiplier: 0.99, sellTaxMultiplier: 0.98 }
    });
    const amount = 1000n;
    expect(registry.applyBuyTax("0xTAX", amount)).toBe(990n);
    expect(registry.applyBuyTax("0xCLEAN", amount)).toBe(1000n);
  });

  it("handles case-insensitivity in addresses", () => {
    const registry = new TokenRegistry({
      "0xTAX": { buyTaxMultiplier: 0.99, sellTaxMultiplier: 0.98 }
    });
    const amount = 1000n;
    expect(registry.applyBuyTax("0xtax", amount)).toBe(990n);
  });
});
