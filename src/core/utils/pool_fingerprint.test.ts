import { describe, it, expect } from "vitest";
import { fingerprintPools } from "./pool_fingerprint.ts";

describe("fingerprintPools", () => {
  it("changes when pool set changes", () => {
    const a = fingerprintPools([{ address: "0xaaa" }, { address: "0xbbb" }]);
    const b = fingerprintPools([{ address: "0xaaa" }, { address: "0xccc" }]);
    expect(a).not.toBe(b);
  });

  it("is order-independent", () => {
    const a = fingerprintPools([{ address: "0xbbb" }, { address: "0xaaa" }]);
    const b = fingerprintPools([{ address: "0xaaa" }, { address: "0xbbb" }]);
    expect(a).toBe(b);
  });

  it("includes count", () => {
    expect(fingerprintPools([])).toBe("0:");
    expect(fingerprintPools([{ address: "0x1" }]).startsWith("1:")).toBe(true);
  });
});
