import { describe, it, expect } from "vitest";
import { isSkipToken } from "./enrichment.ts";

describe("isSkipToken", () => {
  it("returns true for system-prefixed addresses", () => {
    expect(isSkipToken("0x0200000000000000000000000000000000000000" as `0x${string}`)).toBe(true);
    expect(isSkipToken("0x0f00000000000000000000000000000000000000" as `0x${string}`)).toBe(true);
  });
  it("returns false for normal addresses", () => {
    expect(isSkipToken("0x7ceb23fd6bc0add59e62ac25578270cff1b9f619" as `0x${string}`)).toBe(false);
    expect(isSkipToken("0x0000000000000000000000000000000000000000" as `0x${string}`)).toBe(false);
  });
});
