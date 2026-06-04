import { describe, it, expect } from "vitest";
import { decodeFunctionData } from "viem";
import { encodeRoute, computeRouteHash, buildFlashParams } from "./index.ts";
import { V3_POOL_SWAP_ABI } from "./abis.ts";

describe("calldata module", () => {
  it("computeRouteHash produces deterministic 32-byte hash", () => {
    const hash = computeRouteHash([{ target: "0x0000000000000000000000000000000000000001", value: 0n, data: "0x" }]);
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("computeRouteHash is deterministic", () => {
    const calls = [{ target: "0x0000000000000000000000000000000000000001" as const, value: 0n, data: "0x" as const }];
    expect(computeRouteHash(calls)).toBe(computeRouteHash(calls));
  });

  it("computeRouteHash changes when data changes", () => {
    const a = computeRouteHash([{ target: "0x0000000000000000000000000000000000000001", value: 0n, data: "0x" }]);
    const b = computeRouteHash([{ target: "0x0000000000000000000000000000000000000001", value: 0n, data: "0x01" }]);
    expect(a).not.toBe(b);
  });

  it("buildFlashParams builds flash loan params struct", () => {
    const result = buildFlashParams({
      profitToken: "0x0000000000000000000000000000000000000002",
      minProfit: 100n,
      deadline: 9999999999n,
      calls: [{ target: "0x0000000000000000000000000000000000000003", value: 0n, data: "0x" }],
    });
    expect(result.profitToken).toMatch(/^0x[0-9a-f]{40}$/);
    expect(result.minProfit).toBe(100n);
    expect(result.calls).toHaveLength(1);
    expect(result.routeHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("buildFlashParams validates calls array", () => {
    expect(() =>
      buildFlashParams({
        profitToken: "0x0000000000000000000000000000000000000002",
        minProfit: 100n,
        deadline: 9999999999n,
        calls: "not-an-array",
      }),
    ).toThrow("executor calls must be an array");
  });

  it("encodeRoute produces executor calls for a V2 route", () => {
    const calls = encodeRoute(
      {
        path: {
          edges: [
            {
              protocol: "QUICKSWAP_V2",
              poolAddress: "0x0000000000000000000000000000000000000001",
              tokenIn: "0x0000000000000000000000000000000000000002",
              tokenOut: "0x0000000000000000000000000000000000000003",
              zeroForOne: true,
              stateRef: {},
            },
          ],
        },
        result: { hopAmounts: [1000n, 900n] },
      },
      "0x0000000000000000000000000000000000000004",
    );
    expect(calls).toHaveLength(2);
    expect(calls[0].target).toMatch(/^0x[0-9a-f]{40}$/);
    expect(calls[0].value).toBe(0n);
  });

  it("encodeRoute produces negative amountSpecified for V3 hops (exact-input mode)", () => {
    const calls = encodeRoute(
      {
        path: {
          edges: [
            {
              protocol: "UNISWAP_V3",
              poolAddress: "0x0000000000000000000000000000000000000001",
              tokenIn: "0x0000000000000000000000000000000000000002",
              tokenOut: "0x0000000000000000000000000000000000000003",
              zeroForOne: true,
              fee: 3000,
              stateRef: {
                initialized: true,
                sqrtPriceX96: 79228162514264337593543950336n,
                liquidity: 1000000000000000000000000n,
                tick: 0,
                ticks: new Map(),
              },
            },
          ],
        },
        result: { hopAmounts: [1000000000000000000n, 999000000000000000n] },
      },
      "0x0000000000000000000000000000000000000004",
    );
    expect(calls).toHaveLength(1);
    const decoded = decodeFunctionData({
      abi: V3_POOL_SWAP_ABI,
      data: calls[0].data,
    });
    expect(decoded.functionName).toBe("swap");
    const args = (decoded.args ?? []) as readonly unknown[];
    const amountSpecified = args[2] as bigint;
    expect(amountSpecified).toBeLessThan(0n);
  });

  it("encodeRoute throws on unsupported protocol", () => {
    expect(() =>
      encodeRoute(
        {
          path: { edges: [{ protocol: "UNKNOWN_PROTO", stateRef: {} }] },
          result: { hopAmounts: [100n, 90n] },
        },
        "0x0000000000000000000000000000000000000005",
      ),
    ).toThrow("Unsupported protocol for execution: UNKNOWN_PROTO");
  });
});
