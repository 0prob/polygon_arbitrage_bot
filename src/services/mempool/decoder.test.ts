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

  it("detects V3 swap with known pool (direct)", () => {
    const known = new Set(["0xpoolv3"]);
    // selector + recipient(32) + zfo true (32) + amountSpecified positive (32) + ...
    // amount at +128 from after sel, set to 123e18
    const amt = (123n * 10n ** 18n).toString(16).padStart(64, "0");
    const input = "0x128acb08" + "0".repeat(64) + "1".padStart(64, "0") + amt + "0".repeat(64) + "0".repeat(64);
    const result = decodeSwapCalldata("0xpoolv3" as any, input, known);
    expect(result).not.toBeNull();
    expect(result!.protocol).toBe("UNISWAP_V3");
    expect(result!.poolAddress.toLowerCase()).toBe("0xpoolv3");
    expect(result!.amountIn).toBe(123n * 10n ** 18n);
    expect(result!.zeroForOne).toBe(true);
  });

  it("detects via extracted known pool address (indirect/router case)", () => {
    const known = new Set(["0x0000000000000000000000000000000000000abc"]);
    // embed so that extractEncodedAddresses (samples +24 offsets) will pick the 20-byte addr
    const embedded = "0000000000000000000000000000000000000abc";
    const input = "0x128acb08" + "0".repeat(16) + embedded + "0".repeat(40);
    const result = decodeSwapCalldata("0xrouter" as any, input, known);
    expect(result).not.toBeNull();
    expect(result!.poolAddress.toLowerCase()).toBe("0x0000000000000000000000000000000000000abc");
  });

  it("returns null if selector known but no known pool (direct or extracted)", () => {
    const result = decodeSwapCalldata("0xsome" as any, "0x128acb08" + "0".repeat(200), new Set(["0xother"]));
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
