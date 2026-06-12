import { describe, it, expect } from "vitest";
import { buildFastLaneBundle } from "./fastlane_relay.ts";

describe("fastlane_relay", () => {
  it("builds pfl_addSearcherBundle payload", () => {
    const bundle = buildFastLaneBundle("0xdead", { from: "0x1", signature: "0x" } as any, 7);
    expect(bundle.method).toBe("pfl_addSearcherBundle");
    expect(bundle.id).toBe(7);
    expect(bundle.params[0]).toBe("0xdead");
  });
});
