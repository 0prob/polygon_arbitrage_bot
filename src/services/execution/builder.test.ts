import { describe, it, expect } from "vitest";
import { buildArbTx, type BuilderRouteInput, type BuilderConfig } from "./builder.ts";

describe("builder", () => {
  const config: BuilderConfig = {
    executorAddress: "0x1234567890123456789012345678901234567890",
    fromAddress: "0x0000000000000000000000000000000000000001",
  };

  const route: BuilderRouteInput = {
    path: {
      startToken: "0x0000000000000000000000000000000000000001",
      edges: [
        {
          poolAddress: "0x0000000000000000000000000000000000000002",
          tokenIn: "0x0000000000000000000000000000000000000001",
          tokenOut: "0x0000000000000000000000000000000000000003",
          protocol: "UNISWAP_V2",
          zeroForOne: true,
        },
      ],
    },
    result: {
      amountIn: 100n,
      amountOut: 110n,
      hopAmounts: [100n, 110n],
      tokenPath: ["0x0000000000000000000000000000000000000001", "0x0000000000000000000000000000000000000003"],
      poolPath: ["0x0000000000000000000000000000000000000002"],
    },
  };

  it("should build a simple arb transaction", () => {
    const tx = buildArbTx(route, config);
    expect(tx).toBeDefined();
    expect(tx.to).toBe(config.executorAddress);
    expect(tx.data).toBeDefined();
    expect(tx.calls.length).toBe(2); // Transfer + Swap
  });

  it("should fail if amountIn is 0", () => {
    const invalidRoute = {
      ...route,
      result: { ...route.result, amountIn: 0n },
    };
    expect(() => buildArbTx(invalidRoute, config)).toThrow("buildArbTx: result.amountIn must be > 0");
  });
});
