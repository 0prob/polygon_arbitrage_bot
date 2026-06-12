import { describe, it, expect } from "vitest";
import { applyOverrideToPoolState } from "./override_projection.ts";

describe("override_projection", () => {
  it("applies V2 reserve slots from stateDiff", () => {
    const base = { reserve0: 100n, reserve1: 200n };
    const override = {
      "0xpool": {
        stateDiff: {
          "0x0000000000000000000000000000000000000000000000000000000000000008": "0x64",
          "0x0000000000000000000000000000000000000000000000000000000000000009": "0xc8",
        },
      },
    };
    const projected = applyOverrideToPoolState(base, override, "0xpool");
    expect(projected.reserve0).toBe(100n);
    expect(projected.reserve1).toBe(200n);
  });
});
