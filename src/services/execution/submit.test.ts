import { describe, it, expect, vi } from "vitest";
import { SubmissionStrategy } from "./submit.ts";
import type { GasOracle } from "./gas.ts";

describe("SubmissionStrategy gas limit", () => {
  it("passes gasLimit to submitter", async () => {
    const submitter = vi.fn().mockResolvedValue("0xhash");
    const gasOracle = {
      getSnapshot: () => ({
        baseFee: 30n,
        priorityFee: 2n,
        maxFee: 62n,
        gasPrice: 32n,
        timestamp: Date.now(),
      }),
      getEffectiveMaxBidMultiplier: () => 1,
      getPredictedBaseFee: () => 30n,
    } as unknown as GasOracle;

    const logger = { debug: vi.fn() } as any;
    const strategy = new SubmissionStrategy(logger, gasOracle, [submitter], {
      submissionStrategy: "public",
    });

    await strategy.submit(
      {
        to: "0xto",
        data: "0x",
        value: 0n,
        nonce: 1,
        maxFee: 62n,
        gasLimit: 400_000n,
      },
      1_000_000n,
      400_000n,
    );

    expect(submitter).toHaveBeenCalledWith(
      expect.objectContaining({
        gasLimit: 400_000n,
      }),
    );
  });
});
