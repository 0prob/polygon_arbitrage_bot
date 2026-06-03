import { describe, it, expect } from "vitest";
import { buildAbiRegistry } from "./abi-registry.ts";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("abi-registry", () => {
  it("loads ABI files from a directory and indexes selectors", () => {
    const tmpDir = join(tmpdir(), "arb-tx-tools-test-abi");
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
    mkdirSync(tmpDir, { recursive: true });

    writeFileSync(
      join(tmpDir, "test.json"),
      JSON.stringify([
        { type: "function", name: "swap", inputs: [{ name: "amount", type: "uint256" }], stateMutability: "nonpayable" },
        { type: "error", name: "InsufficientOutputAmount", inputs: [{ name: "amount", type: "uint256" }] },
      ]),
    );

    const registry = buildAbiRegistry(tmpDir);

    // Should have indexed the function selector
    const funcKeys = Object.keys(registry.functions);
    expect(funcKeys.length).toBeGreaterThan(0);
    // swap(uint256) should be present
    expect(registry.functions[funcKeys[0]].name).toBe("swap");

    // Should have indexed the error selector
    const errKeys = Object.keys(registry.errors);
    expect(errKeys.length).toBeGreaterThan(0);
    expect(registry.errors[errKeys[0]].name).toBe("InsufficientOutputAmount");

    rmSync(tmpDir, { recursive: true });
  });

  it("handles missing directory gracefully", () => {
    const registry = buildAbiRegistry("/nonexistent/path");
    expect(registry.functions).toEqual({});
    expect(registry.errors).toEqual({});
  });

  it("includes extra ABIs passed as argument", () => {
    const extra = [{ type: "error", name: "CustomError", inputs: [{ name: "x", type: "uint256" }] }];
    const registry = buildAbiRegistry("/nonexistent", [extra as unknown as Record<string, unknown>]);
    const errKeys = Object.keys(registry.errors);
    expect(errKeys.length).toBeGreaterThan(0);
    expect(registry.errors[errKeys[0]].name).toBe("CustomError");
  });
});
