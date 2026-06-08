import { describe, it, expect, vi } from "vitest";
import { toViemStateOverride, mergeStateOverride } from "../../core/types/state-override.ts";
import type { StateOverride } from "../../core/types/state-override.ts";
import { PendingOverrideStore } from "./pending-override.ts";
import { buildStateOverride } from "./state-override-builder.ts";
import { debugTraceCall, debugTraceCallBatch } from "./trace-fallback.ts";
import type { PoolState } from "../../core/types/pool.ts";

describe("State Override - Formatting and Merging", () => {
  it("toViemStateOverride handles numeric/zero edge cases correctly", () => {
    const internalOverride: StateOverride = {
      "0xpool": {
        stateDiff: {
          "0x1": "0x2",
        },
        balance: "0",
        nonce: "0",
        code: "0x1234",
      },
    };

    const viemFormat = toViemStateOverride(internalOverride);
    expect(viemFormat).toHaveLength(1);
    expect(viemFormat[0]).toEqual({
      address: "0xpool",
      stateDiff: [{ slot: "0x1", value: "0x2" }],
      balance: 0n,
      nonce: 0,
      code: "0x1234",
    });
  });

  it("mergeStateOverride merges all fields and handles deep cloning", () => {
    const target: StateOverride = {
      "0xpool": {
        stateDiff: {
          "0x1": "0x2",
        },
        balance: "100",
        nonce: "1",
      },
    };

    const source: StateOverride = {
      "0xpool": {
        stateDiff: {
          "0x1": "0x3",
          "0x2": "0x4",
        },
        balance: "200",
        code: "0x5555",
      },
      "0xother": {
        stateDiff: {
          "0x9": "0x9",
        },
        nonce: "5",
      },
    };

    mergeStateOverride(target, source);

    // Assert target is updated
    expect(target["0xpool"]).toEqual({
      stateDiff: {
        "0x1": "0x3",
        "0x2": "0x4",
      },
      balance: "200",
      nonce: "1",
      code: "0x5555",
    });

    expect(target["0xother"]).toEqual({
      stateDiff: {
        "0x9": "0x9",
      },
      nonce: "5",
    });
  });
});

describe("PendingOverrideStore", () => {
  it("manages override entries, merges consecutive txs, and respects ttl", () => {
    vi.useFakeTimers();
    const store = new PendingOverrideStore({ ttlMs: 1000 });

    const override1: StateOverride = {
      "0xpool1": { stateDiff: { "0x1": "0x10" } },
    };
    const override2: StateOverride = {
      "0xpool1": { stateDiff: { "0x1": "0x20", "0x2": "0x30" } },
      "0xpool2": { stateDiff: { "0x3": "0x40" } },
    };

    store.update(override1, ["0xpool1"], "hash1");
    expect(store.hasActive()).toBe(true);
    expect(store.isAffected("0xpool1")).toBe(true);
    expect(store.isAffected("0xpool2")).toBe(false);

    // Advance time and merge second tx within TTL
    vi.advanceTimersByTime(500);
    store.update(override2, ["0xpool1", "0xpool2"], "hash2");

    const current = store.get();
    expect(current).toEqual({
      "0xpool1": {
        stateDiff: { "0x1": "0x20", "0x2": "0x30" },
      },
      "0xpool2": {
        stateDiff: { "0x3": "0x40" },
      },
    });
    expect(store.isAffected("0xpool2")).toBe(true);

    // Advance past TTL
    vi.advanceTimersByTime(1100);
    expect(store.hasActive()).toBe(false);
    expect(store.get()).toBeNull();

    vi.useRealTimers();
  });
});

describe("State Override Builder - Manual Construction", () => {
  const mockV2State: PoolState = {
    reserve0: 1000000n,
    reserve1: 2000000n,
    initialized: true,
  } as any;

  const mockV3State: PoolState = {
    sqrtPriceX96: 79228162514264337593543950336n, // 1:1 ratio (tick 0)
    liquidity: 1000000000000000000n,
    fee: 3000n,
    initialized: true,
  } as any;

  it("builds V2 overrides correctly, handling swap math & fee bps", () => {
    const input = {
      poolAddress: "0xpoolv2" as const,
      protocol: "V2",
      tokenIn: "0xtoken0" as const,
      tokenOut: "0xtoken1" as const,
      amountIn: 10000n,
      zeroForOne: true,
      swapFeeBps: 30, // 0.3%
      currentState: mockV2State,
    };

    const override = buildStateOverride(input);
    expect(override).not.toBeNull();
    const state = override!["0xpoolv2"];
    expect(state).toBeDefined();
    expect(state.stateDiff).toBeDefined();

    // reserve0 (slot 8) should increase by amountIn (10000)
    // reserve1 (slot 9) should decrease by amountOut (approx 19743)
    const slot0 = "0x0000000000000000000000000000000000000000000000000000000000000008";
    const slot1 = "0x0000000000000000000000000000000000000000000000000000000000000009";

    const newR0 = BigInt(state.stateDiff![slot0]);
    const newR1 = BigInt(state.stateDiff![slot1]);

    expect(newR0).toBe(1000000n + 10000n);
    expect(newR1).toBeLessThan(2000000n);
  });

  it("builds V3 overrides with correct slot0 layout packing", () => {
    const input = {
      poolAddress: "0xpoolv3" as const,
      protocol: "V3",
      tokenIn: "0xtoken0" as const,
      tokenOut: "0xtoken1" as const,
      amountIn: 10000n,
      zeroForOne: true,
      currentState: mockV3State,
    };

    const override = buildStateOverride(input);
    expect(override).not.toBeNull();
    const state = override!["0xpoolv3"];
    expect(state).toBeDefined();
    expect(state.stateDiff).toBeDefined();

    // V3_SLOT0_SLOT is 0
    const slot0Value = BigInt(state.stateDiff!["0x0000000000000000000000000000000000000000000000000000000000000000"]);

    // Decode slot0Packed:
    // sqrtPriceX96: bits 0..159
    // tick: bits 160..183
    // unlocked: bit 240 (value: 1)
    const sqrtPriceX96 = slot0Value & ((1n << 160n) - 1n);
    const tickRaw = (slot0Value >> 160n) & 0xffffffn;
    const tick = tickRaw > 0x7fffffn ? Number(tickRaw - 0x1000000n) : Number(tickRaw);
    const unlocked = (slot0Value >> 240n) & 1n;

    expect(unlocked).toBe(1n); // MUST be unlocked (true / 1)
    expect(sqrtPriceX96).toBeLessThan(79228162514264337593543950336n); // price should have moved down (zeroForOne)
    expect(tick).toBeLessThan(0); // tick should have moved down (negative)
  });

  it("builds V4 overrides with correct mapping slots and layout packing", () => {
    const input = {
      poolAddress: "0x0000000000000000000000000000000000000003" as const,
      protocol: "V4",
      tokenIn: "0x0000000000000000000000000000000000000001" as const,
      tokenOut: "0x0000000000000000000000000000000000000002" as const,
      amountIn: 10000n,
      zeroForOne: true,
      currentState: mockV3State, // V4 uses V3 swap math/state structure for prices
      poolManagerAddress: "0x0000000000000000000000000000000000000004" as const,
      currency0: "0x0000000000000000000000000000000000000001" as const,
      currency1: "0x0000000000000000000000000000000000000002" as const,
      hooks: "0x0000000000000000000000000000000000000000" as const,
      tickSpacing: 60,
      fee: 3000,
    };

    const override = buildStateOverride(input);
    expect(override).not.toBeNull();
    const managerState = override!["0x0000000000000000000000000000000000000004"];
    expect(managerState).toBeDefined();
    expect(managerState.stateDiff).toBeDefined();

    // Verify slots are present (non-empty)
    const slots = Object.keys(managerState.stateDiff!);
    expect(slots).toHaveLength(2); // slot0 slot and liquidity slot
  });
});

describe("State Override - Trace Fallback", () => {
  it("debugTraceCall handles RPC result and constructs full StateOverride object", async () => {
    const mockRequest = vi.fn().mockResolvedValue({
      stateDiff: {
        "0xpool": {
          storage: {
            "0x0": { from: "0x0", to: "0x123" },
          },
          balance: { from: "0x10", to: "0x20" },
          nonce: { from: 1, to: 2 },
          code: { from: "0x", to: "0x6060" },
        },
      },
    });

    const mockClient = {
      request: mockRequest,
    } as any;

    const result = await debugTraceCall(mockClient, {
      to: "0xrouter",
      data: "0xdeadbeef",
    });

    expect(result.success).toBe(true);
    expect(result.stateOverride).toEqual({
      "0xpool": {
        stateDiff: {
          "0x0000000000000000000000000000000000000000000000000000000000000000": "0x123",
        },
        balance: "0x20",
        nonce: "2",
        code: "0x6060",
      },
    });
    expect(result.affectedPools).toEqual(["0xpool"]);

    // Verify params passed to RPC request
    expect(mockRequest).toHaveBeenCalledWith({
      method: "debug_traceCall",
      params: [
        { to: "0xrouter", data: "0xdeadbeef" },
        "pending",
        {
          tracer: "prestateTracer",
          tracerConfig: { diffMode: true },
          timeout: "5s",
        },
      ],
    });
  });

  it("debugTraceCallBatch merges consecutive tx traces", async () => {
    const mockRequest = vi
      .fn()
      .mockResolvedValueOnce({
        stateDiff: {
          "0xpool": {
            storage: { "0x1": { from: "0x0", to: "0x10" } },
          },
        },
      })
      .mockResolvedValueOnce({
        stateDiff: {
          "0xpool": {
            storage: { "0x1": { from: "0x10", to: "0x20" }, "0x2": { from: "0x0", to: "0x30" } },
          },
        },
      });

    const mockClient = {
      request: mockRequest,
    } as any;

    const result = await debugTraceCallBatch(mockClient, [
      { to: "0xrouter", data: "0x1" },
      { to: "0xrouter", data: "0x2" },
    ]);

    expect(result.success).toBe(true);
    expect(result.stateOverride).toEqual({
      "0xpool": {
        stateDiff: {
          "0x0000000000000000000000000000000000000000000000000000000000000001": "0x20",
          "0x0000000000000000000000000000000000000000000000000000000000000002": "0x30",
        },
      },
    });
  });
});
