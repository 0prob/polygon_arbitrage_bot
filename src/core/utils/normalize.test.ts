import { describe, it, expect } from "vitest";
import { normalizeAddress, normalizeBlockHash, normalizePoolAddress } from "./normalize.ts";

describe("normalize", () => {
  it("normalizeAddress lowercases", () => {
    expect(normalizeAddress("0xAbCd")).toBe("0xabcd");
  });

  it("normalizePoolAddress matches address normalization", () => {
    expect(normalizePoolAddress("0xPOOL")).toBe(normalizeAddress("0xPOOL"));
  });

  it("normalizeBlockHash strips 0x and lowercases", () => {
    expect(normalizeBlockHash("0xAbCdEf")).toBe("abcdef");
    expect(normalizeBlockHash("AbCdEf")).toBe("abcdef");
  });
});
