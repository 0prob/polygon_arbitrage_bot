import { describe, it, expect } from "vitest";
import { decodeFunctionData } from "viem";
import { encodeRoute, computeRouteHash, buildFlashParams } from "./index.ts";
import { UNISWAP_V3_POOL_ABI } from "../../../core/abis/compiled/index.ts";
import { ARB_EXECUTOR_ABI } from "../../../core/abis/executor.ts";

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

  it("encodeRoute produces transferAll call for intermediate V2 hops (i > 0)", () => {
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
            {
              protocol: "SUSHISWAP_V2",
              poolAddress: "0x0000000000000000000000000000000000000005",
              tokenIn: "0x0000000000000000000000000000000000000003",
              tokenOut: "0x0000000000000000000000000000000000000006",
              zeroForOne: true,
              stateRef: {},
            },
          ],
        },
        result: { hopAmounts: [1000n, 900n, 800n] },
      },
      "0x0000000000000000000000000000000000000004",
    );
    // 2 calls for first hop (transfer + swap)
    // 2 calls for second hop (transferAll + swap)
    expect(calls).toHaveLength(4);
    // Check first hop transfer (to pool 1)
    const decoded0 = decodeFunctionData({
      abi: [{ name: "transfer", type: "function", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [] }],
      data: calls[0].data,
    });
    expect(decoded0.functionName).toBe("transfer");
    expect(decoded0.args![0]).toBe("0x0000000000000000000000000000000000000001");
    expect(decoded0.args![1]).toBe(1000n);

    // Check second hop transferAll (to pool 2)
    const decoded2 = decodeFunctionData({
      abi: ARB_EXECUTOR_ABI,
      data: calls[2].data,
    });
    expect(decoded2.functionName).toBe("transferAll");
    expect(decoded2.args![0]).toBe("0x0000000000000000000000000000000000000003");
    expect(decoded2.args![1]).toBe("0x0000000000000000000000000000000000000005");
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
        result: { hopAmounts: [1000000000000000000n, 996999005991991025n] },
      },
      "0x0000000000000000000000000000000000000004",
    );
    expect(calls).toHaveLength(1);
    const decoded = decodeFunctionData({
      abi: UNISWAP_V3_POOL_ABI,
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

  it("encodeRoute produces vault swap call for Balancer hops", () => {
    const poolId = "0x" + "ab".repeat(32);
    const calls = encodeRoute(
      {
        path: {
          edges: [
            {
              protocol: "BALANCER",
              poolAddress: "0x0000000000000000000000000000000000000001",
              poolId,
              tokenIn: "0x0000000000000000000000000000000000000002",
              tokenOut: "0x0000000000000000000000000000000000000003",
              tokenInIdx: 0,
              tokenOutIdx: 1,
              zeroForOne: true,
              stateRef: {},
            },
          ],
        },
        result: { hopAmounts: [1000n, 900n] },
      },
      "0x0000000000000000000000000000000000000004",
      { deadline: 9999999999n },
    );
    expect(calls).toHaveLength(2);
    const decoded = decodeFunctionData({
      abi: [
        {
          type: "function",
          name: "swap",
          inputs: [
            {
              name: "singleSwap",
              type: "tuple",
              components: [
                { name: "poolId", type: "bytes32" },
                { name: "kind", type: "uint8" },
                { name: "assetIn", type: "address" },
                { name: "assetOut", type: "address" },
                { name: "amount", type: "uint256" },
                { name: "userData", type: "bytes" },
              ],
            },
            {
              name: "funds",
              type: "tuple",
              components: [
                { name: "sender", type: "address" },
                { name: "fromInternalBalance", type: "bool" },
                { name: "recipient", type: "address" },
                { name: "toInternalBalance", type: "bool" },
              ],
            },
            { name: "limit", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
          outputs: [{ name: "amountCalculated", type: "uint256" }],
          stateMutability: "payable",
        },
      ],
      data: calls[1].data,
    });
    expect(decoded.functionName).toBe("swap");
  });
});
