import { describe, it, expect, beforeEach } from "vitest";
import type { Address } from "./common.ts";
import type { PoolState } from "./pool.ts";
import { InMemoryPendingStateOverlay } from "./overlay.ts";

describe("InMemoryPendingStateOverlay", () => {
  let overlay: InMemoryPendingStateOverlay;

  beforeEach(() => {
    overlay = new InMemoryPendingStateOverlay();
  });

  it("should update and get state", () => {
    const address = "0x1234567890123456789012345678901234567890" as Address;
    const state: PoolState = { reserve0: 100n, reserve1: 200n };
    overlay.update(address, state);
    expect(overlay.get(address)).toEqual(state);
  });

  it("should return undefined for expired state", async () => {
    const address = "0x1234567890123456789012345678901234567890" as Address;
    const state: PoolState = { reserve0: 100n, reserve1: 200n };
    overlay.update(address, state);

    // Manually wait for TTL (1000ms)
    await new Promise((resolve) => setTimeout(resolve, 1050));

    expect(overlay.get(address)).toBeUndefined();
  });

  it("should clear all states", () => {
    const address1 = "0x1234567890123456789012345678901234567890" as Address;
    const address2 = "0x0000000000000000000000000000000000000000" as Address;
    const state: PoolState = { reserve0: 100n, reserve1: 200n };
    overlay.update(address1, state);
    overlay.update(address2, state);
    overlay.clear();
    expect(overlay.get(address1)).toBeUndefined();
    expect(overlay.get(address2)).toBeUndefined();
  });

  it("getProjected combines delta with base state", () => {
    const address = "0x1234567890123456789012345678901234567890" as Address;
    const delta: PoolState = { reserve0: -10n, reserve1: 10n };
    overlay.update(address, delta);
    const baseState: PoolState = { reserve0: 1000n, reserve1: 2000n };
    const projected = overlay.getProjected(address, baseState);
    expect(projected).toEqual({ reserve0: 990n, reserve1: 2010n });
  });

  it("getProjected returns undefined for unknown address", () => {
    const address = "0x1234567890123456789012345678901234567890" as Address;
    const baseState: PoolState = { reserve0: 1000n, reserve1: 2000n };
    expect(overlay.getProjected(address, baseState)).toBeUndefined();
  });
});
