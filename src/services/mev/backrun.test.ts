import { describe, it, expect } from "vitest";
import { buildPlaceholderSolverOp, findBackrunTxInBlock } from "./backrun.ts";
import type { CandidateExecution } from "../execution/service.ts";

describe("findBackrunTxInBlock", () => {
  const candidate: CandidateExecution = {
    routeKey: "route",
    calldata: "0xdeadbeef",
    targetAddress: "0x00000000000000000000000000000000000000ee",
    value: 0n,
  };

  it("finds a matching operator backrun tx in a block", () => {
    const hash = findBackrunTxInBlock(
      [
        {
          hash: "0x1111",
          from: "0x00000000000000000000000000000000000000aa",
          to: "0x00000000000000000000000000000000000000ee",
          input: "0xdeadbeef",
        },
      ],
      "0x00000000000000000000000000000000000000Aa",
      candidate,
    );

    expect(hash).toBe("0x1111");
  });

  it("returns null when calldata does not match", () => {
    const hash = findBackrunTxInBlock(
      [
        {
          hash: "0x1111",
          from: "0x00000000000000000000000000000000000000aa",
          to: "0x00000000000000000000000000000000000000ee",
          input: "0xbeef",
        },
      ],
      "0x00000000000000000000000000000000000000aa",
      candidate,
    );

    expect(hash).toBeNull();
  });

  it("embeds live nonce and gas fields in placeholder solver op", () => {
    const op = buildPlaceholderSolverOp(
      {
        victim: {
          type: "large_swap",
          data: {
            txHash: "0xvictim",
            poolAddress: "0xpool",
            estimatedSwapSize: 1n,
            traceId: "t",
          },
        } as any,
        candidate,
        operatorAddress: "0x00000000000000000000000000000000000000aa",
      },
      { nonce: 12, maxFeePerGas: 100n, maxPriorityFeePerGas: 25n },
    );

    expect(op.nonce).toBe("0xc");
    expect(op.maxFeePerGas).toBe("0x64");
    expect(op.maxPriorityFeePerGas).toBe("0x19");
  });
});
