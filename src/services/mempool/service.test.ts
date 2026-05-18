import { describe, it, expect } from "vitest";
import { MempoolService } from "./service.ts";
import type { MempoolSignal } from "./signals.ts";

describe("MempoolService", () => {
  it("emits large_swap signal for matching V2 swap", () => {
    const signals: MempoolSignal[] = [];
    const service = new MempoolService({} as any, { coalesceTtlMs: 100, largeSwapThresholdWei: 1n });
    service.setKnownPools(["0xpool1"]);
    service.onSignal((s) => signals.push(s));

    // V2 swap selector + amount0Out > threshold
    const tx = {
      hash: "0xabc",
      to: "0xpool1",
      input: "0x022c0d9f" + "1".repeat(64) + "0".repeat(64) + "0".repeat(64) + "0".repeat(64),
      value: "0x0",
    };
    service.processPendingTx(tx);
    expect(signals.length).toBeGreaterThanOrEqual(1);
  });

  it("does not emit for unknown pool", () => {
    const signals: MempoolSignal[] = [];
    const service = new MempoolService({} as any, { coalesceTtlMs: 100, largeSwapThresholdWei: 1n });
    service.onSignal((s) => signals.push(s));

    service.processPendingTx({ hash: "0xabc", to: "0xunknown", input: "0x022c0d9f" + "0".repeat(200), value: "0x0" });
    expect(signals.length).toBe(0);
  });
});
