import { describe, it, expect } from "vitest";
import { decodeSwapCalldata, extractEncodedAddresses } from "./decoder.ts";

describe("decodeSwapCalldata", () => {
  it("detects V2 swap with known pool", () => {
    const known = new Set(["0xpool1"]);
    // V2 swap(uint256,uint256,address,bytes)
    const input = "0x022c0d9f" + "0".repeat(63) + "1" + "0".repeat(128);
    const result = decodeSwapCalldata("0xpool1" as any, input, known);
    expect(result).not.toBeNull();
    expect(result!.protocol).toBe("UNISWAP_V2");
  });

  it("returns null for unknown selector", () => {
    const result = decodeSwapCalldata("0xpool" as any, "0xdeadbeef", new Set());
    expect(result).toBeNull();
  });
});

describe("extractEncodedAddresses", () => {
  it("extracts addresses from input data", () => {
    const input = "0x" + "ab".repeat(20) + "cd".repeat(44);
    const addrs = extractEncodedAddresses(input);
    expect(addrs.length).toBeGreaterThan(0);
  });
});
