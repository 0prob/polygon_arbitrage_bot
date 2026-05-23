import { describe, it, expect } from "vitest";
import type { Address, FeeSnapshot } from "./common.ts";
describe("common types", () => {
  it("Address type accepts valid hex strings", () => {
    const addr: Address = "0x0000000000000000000000000000000000000001";
    expect(addr.startsWith("0x")).toBe(true);
  });
  it("FeeSnapshot has required fields", () => {
    const snap: FeeSnapshot = {
      baseFee: 30_000_000_000n,
      priorityFee: 30_000_000_000n,
      maxFee: 90_000_000_000n,
      gasPrice: 60_000_000_000n,
      timestamp: Date.now(),
    };
    expect(snap.baseFee).toBe(30_000_000_000n);
  });
});
