import { describe, it, expect } from "vitest";
import { applyOverrideToPoolState, getProjectedPoolState } from "./override_projection.ts";
import { refreshProjectedStates } from "../../pipeline/simulator.ts";
import { InMemoryPendingStateOverlay } from "../../core/types/overlay.ts";
import { PendingOverrideStore } from "./pending-override.ts";
import type { SimulationEdge } from "../../pipeline/types.ts";

describe("override_projection", () => {
  it("applies V2 reserve slots from stateDiff", () => {
    const base = { reserve0: 100n, reserve1: 200n };
    const override = {
      "0xpool": {
        stateDiff: {
          "0x0000000000000000000000000000000000000000000000000000000000000008": "0x12c",
          "0x0000000000000000000000000000000000000000000000000000000000000009": "0x1f4",
        },
      },
    };
    const projected = applyOverrideToPoolState(base, override, "0xpool");
    expect(projected.reserve0).toBe(300n);
    expect(projected.reserve1).toBe(500n);
  });

  it("clears tick data when V3 slot0 is overridden", () => {
    const base = {
      sqrtPriceX96: 1000n,
      liquidity: 500n,
      tick: 0,
      ticks: new Map([[0, { liquidityNet: 1n }]]),
      tickVersion: 3,
    };
    const override = {
      "0xpool": {
        stateDiff: {
          "0x0000000000000000000000000000000000000000000000000000000000000000": "0x2",
        },
      },
    };
    const projected = applyOverrideToPoolState(base, override, "0xpool");
    expect(projected.sqrtPriceX96).toBe(2n);
    expect(projected.ticks).toBeUndefined();
    expect(projected.tickVersion).toBe(4);
  });

  it("prefers override store over overlay for the same pool", () => {
    const overlay = new InMemoryPendingStateOverlay();
    overlay.update("0xpool", { reserve0: 999n });

    const store = new PendingOverrideStore({ ttlMs: 60_000 });
    store.update(
      {
        "0xpool": {
          stateDiff: {
            "0x0000000000000000000000000000000000000000000000000000000000000008": "0x64",
            "0x0000000000000000000000000000000000000000000000000000000000000009": "0xc8",
          },
        },
      },
      ["0xpool"],
      "0x1",
    );

    const base = { reserve0: 1000n, reserve1: 2000n };
    const projected = getProjectedPoolState("0xpool", base, overlay, store);
    expect(projected.reserve0).toBe(100n);
    expect(projected.reserve1).toBe(200n);
  });

  it("uses overlay when override store has no entry for pool", () => {
    const overlay = new InMemoryPendingStateOverlay();
    overlay.update("0xpool", { reserve0: 50n });

    const base = { reserve0: 1000n, reserve1: 2000n };
    const projected = getProjectedPoolState("0xpool", base, overlay);
    expect(projected.reserve0).toBe(1050n);
  });

  it("refreshProjectedStates updates prebuilt edge state from override store", () => {
    const store = new PendingOverrideStore({ ttlMs: 60_000 });
    store.update(
      {
        "0xpool": {
          stateDiff: {
            "0x0000000000000000000000000000000000000000000000000000000000000008": "0x64",
          },
        },
      },
      ["0xpool"],
      "0x1",
    );

    const stateCache = new Map<string, Record<string, unknown>>();
    stateCache.set("0xpool", { reserve0: 1000n, reserve1: 2000n });
    const simEdges: SimulationEdge[] = [
      {
        poolAddress: "0xpool",
        tokenIn: "0xa",
        tokenOut: "0xb",
        protocol: "UNISWAP_V2",
        normalizedProtocol: "V2",
        zeroForOne: true,
        stateRef: { reserve0: 1000n, reserve1: 2000n },
      },
    ];

    refreshProjectedStates(simEdges, stateCache, undefined, store);
    expect(simEdges[0].stateRef?.reserve0).toBe(100n);
  });
});
