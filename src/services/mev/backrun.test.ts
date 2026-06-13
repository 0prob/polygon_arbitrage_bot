import { describe, it, expect } from "vitest";
import { findBackrunTxInBlock } from "./backrun.ts";
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
});
