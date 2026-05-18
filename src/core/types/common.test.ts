import { describe, it, expect } from "vitest";
import type { Address, FeeSnapshot } from "./common.ts";
describe("common types", () => {
  it("Address type accepts valid hex strings", () => {
    const addr: Address = "0x0000000000000000000000000000000000000001";
    expect(addr.startsWith("0x")).toBe(true);
  });
  it("FeeSnapshot has required fields", () => {
    const snap: FeeSnapshot = {
      baseFeeWei: 30_000_000_000n,
      priorityFeeWei: 30_000_000_000n,
      maxFeeWei: 90_000_000_000n,
      gasPriceWei: 60_000_000_000n,
      timestampMs: Date.now(),
    };
    expect(snap.baseFeeWei).toBe(30_000_000_000n);
  });
});
