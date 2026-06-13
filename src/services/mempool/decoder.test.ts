import { describe, it, expect } from "vitest";
import { decodeSwapCalldata, extractEncodedAddresses } from "./decoder.ts";
import { AbiRegistry } from "../../core/abis/registry.ts";
import { COMPILED_ABIS, UNISWAP_V2_POOL_ABI, UNISWAP_V3_POOL_ABI } from "../../core/abis/compiled/index.ts";
import { encodeFunctionData } from "viem";

const registry = new AbiRegistry();
Object.entries(COMPILED_ABIS).forEach(([tag, abi]) => {
  registry.registerAbi(abi, tag);
});

describe("decodeSwapCalldata", () => {
  it("detects V2 swap with known pool", () => {
    const known = new Set(["0xpool1"]);
    const input = encodeFunctionData({
      abi: UNISWAP_V2_POOL_ABI,
      functionName: "swap",
      args: [0n, 1n, "0x0000000000000000000000000000000000000000", "0x"],
    });
    const result = decodeSwapCalldata("0xpool1" as any, input, known, registry);
    expect(result).not.toBeNull();
    expect(result!.protocol).toBe("uniswap_v2_pool");
  });

  it("returns null for unknown selector", () => {
    const result = decodeSwapCalldata("0xpool" as any, "0xdeadbeef", new Set(), registry);
    expect(result).toBeNull();
  });

  it("detects V3 swap with known pool (direct)", () => {
    const known = new Set(["0xpoolv3"]);
    const input = encodeFunctionData({
      abi: UNISWAP_V3_POOL_ABI,
      functionName: "swap",
      args: ["0x0000000000000000000000000000000000000000", true, 123n * 10n ** 18n, 0n, "0x"],
    });
    const result = decodeSwapCalldata("0xpoolv3" as any, input, known, registry);
    expect(result).not.toBeNull();
    expect(result!.protocol).toBe("uniswap_v3_pool");
    expect(result!.poolAddress.toLowerCase()).toBe("0xpoolv3");
    expect(result!.amountIn).toBe(123n * 10n ** 18n);
    expect(result!.zeroForOne).toBe(true);
  });

  it("detects via extracted known pool address (indirect/router case)", () => {
    const pool = "0x0000000000000000000000000000000000000abc";
    const known = new Set([pool]);
    const input = encodeFunctionData({
      abi: UNISWAP_V3_POOL_ABI,
      functionName: "swap",
      args: [pool, true, 123n * 10n ** 18n, 0n, "0x"],
    });
    const result = decodeSwapCalldata("0xrouter" as any, input, known, registry);
    expect(result).not.toBeNull();
    expect(result!.poolAddress.toLowerCase()).toBe(pool);
  });

  it("returns null if selector known but no known pool (direct or extracted)", () => {
    const result = decodeSwapCalldata("0xsome" as any, "0x128acb08" + "0".repeat(200), new Set(["0xother"]), registry);
    expect(result).toBeNull();
  });
});

describe("extractEncodedAddresses", () => {
  it("extracts addresses from input data", () => {
    const input = "0x" + "ab".repeat(20) + "cd".repeat(44);
    const addrs = extractEncodedAddresses(input);
    expect(addrs.length).toBeGreaterThan(0);
  });

  it("prefers word-aligned known pool hits over substring scan", () => {
    const pool = "0x0000000000000000000000000000000000000abc";
    const known = new Set([pool]);
    const input = encodeFunctionData({
      abi: UNISWAP_V3_POOL_ABI,
      functionName: "swap",
      args: [pool, true, 123n * 10n ** 18n, 0n, "0x"],
    });
    const addrs = extractEncodedAddresses(input, known);
    expect(addrs).toContain(pool);
  });
});
