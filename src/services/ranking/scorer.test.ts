import { describe, it, expect } from "vitest";
import { scoreCandidateEv, sortCandidatesByEv } from "./scorer.ts";
import { ExecutionTracker } from "../execution/tracker.ts";

describe("ranking scorer", () => {
  it("scores higher EV for higher win rate", () => {
    const candidate = {
      routeKey: "a",
      expectedProfit: 1_000_000_000_000_000_000n,
      gasLimit: 300_000n,
      gasPriceWei: 30_000_000_000n,
    };
    const low = scoreCandidateEv(candidate, 0.1);
    const high = scoreCandidateEv(candidate, 0.8);
    expect(high).toBeGreaterThan(low);
  });

  it("sortCandidatesByEv orders by score", () => {
    const tracker = new ExecutionTracker();
    tracker.record({
      routeKey: "good",
      txHash: "0x1",
      success: true,
      gasUsed: 1n,
      profit: 1n,
      timestamp: Date.now(),
      pools: [],
    });
    const sorted = sortCandidatesByEv(
      [
        { routeKey: "bad", expectedProfit: 2n, gasPriceWei: 1n },
        { routeKey: "good", expectedProfit: 1n, gasPriceWei: 1n },
      ],
      tracker,
      () => false,
    );
    expect(sorted[0].routeKey).toBe("good");
  });
});
