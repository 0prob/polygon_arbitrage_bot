import { describe, it, expect } from "vitest";
import { publishHfSnapshot, getHfSnapshot } from "./hf_snapshot.ts";
import type { PassLoopState } from "./pass_state.ts";

function emptyState(): PassLoopState {
  return {
    cachedCycles: [],
    hasuraPoolsCache: null,
    cachedMetas: null,
    cachedRates: null,
    tokenToMaticRates: new Map([["0xt", 100n]]),
    ratesNeedFullRefresh: false,
    pendingFocusTokens: null,
    lastRefreshTime: 0,
    lastReorgCheck: 0,
    lastStatusWriteTime: 0,
    lastMempoolTraceId: undefined,
    lfEnumerationInFlight: false,
    lastEnumerationTime: 0,
    lastPoolsFingerprint: "",
    cycleWindowStart: Date.now(),
    recentRouteTimestamps: new Map(),
    headTriggered: false,
    lastHeadTime: 0,
    lastTierCheck: 0,
    lfTickInFlight: false,
    maticPriceUsd: 0.7,
    cyclesGeneration: 0,
    hfSnapshot: null,
  };
}

describe("hf_snapshot", () => {
  it("publishes immutable rate map copy", () => {
    const state = emptyState();
    publishHfSnapshot(state);
    const snap = getHfSnapshot(state);
    state.tokenToMaticRates.set("0xt", 999n);
    expect(snap.tokenToMaticRates.get("0xt")).toBe(100n);
    expect(snap.generation).toBe(1);
  });

  it("bumps generation on each publish", () => {
    const state = emptyState();
    publishHfSnapshot(state);
    publishHfSnapshot(state);
    expect(getHfSnapshot(state).generation).toBe(2);
  });
});
