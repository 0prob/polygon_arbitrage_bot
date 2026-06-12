import { describe, it, expect, vi } from "vitest";
import { MempoolAwareDryRunner } from "./dryrun.ts";
import { PendingOverrideStore } from "../mempool/pending-override.ts";

describe("MempoolAwareDryRunner", () => {
  it("forwards stateOverride to call and estimateGas", async () => {
    const call = vi.fn().mockResolvedValue(undefined);
    const estimateGas = vi.fn().mockResolvedValue(350_000n);
    const client = { call, estimateGas } as any;

    const store = new PendingOverrideStore({ ttlMs: 60_000 });
    store.update(
      {
        "0xpool": {
          stateDiff: {
            "0x0000000000000000000000000000000000000000000000000000000000000000": "0x01",
          },
        },
      },
      ["0xpool"],
      "0xtx",
    );

    const runner = new MempoolAwareDryRunner(client, store);
    const result = await runner.dryRun(
      {
        routeKey: "k",
        calldata: "0x1234",
        targetAddress: "0xexec",
        value: 0n,
        expectedProfit: 1n,
      },
      "0xoperator",
    );

    expect(result.success).toBe(true);
    expect(result.gasUsed).toBe(350_000n);
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({
        blockTag: "pending",
        stateOverride: expect.any(Array),
      }),
    );
    expect(estimateGas).toHaveBeenCalledWith(
      expect.objectContaining({
        blockTag: "pending",
        stateOverride: expect.any(Array),
      }),
    );
  });
});
