import { describe, it, expect, beforeEach } from "vitest";
import { ExecutionTracker } from "./tracker.ts";

describe("ExecutionTracker", () => {
  let tracker: ExecutionTracker;

  beforeEach(() => {
    tracker = new ExecutionTracker(100);
  });

  const makeRecord = (overrides: Partial<import("./tracker.ts").ExecutionRecord> = {}) => ({
    routeKey: "route-a",
    txHash: "0xabc",
    success: true,
    gasUsed: 100_000n,
    profit: 50n,
    timestamp: Date.now(),
    pools: ["0xpool"],
    ...overrides,
  });

  it("starts empty", () => {
    expect(tracker.summary.totalAttempts).toBe(0);
    expect(tracker.summary.trackedRoutes).toBe(0);
  });

  it("tracks a single record", () => {
    tracker.record(makeRecord());
    expect(tracker.summary.totalAttempts).toBe(1);
    expect(tracker.summary.totalSuccesses).toBe(1);
    expect(tracker.summary.totalProfit).toBe(50n);
  });

  it("tracks failures separately", () => {
    tracker.record(makeRecord({ success: false, error: "revert" }));
    expect(tracker.summary.totalReverts).toBe(1);
    expect(tracker.summary.totalSuccesses).toBe(0);
  });

  it("computes win rate", () => {
    tracker.record(makeRecord({ success: true }));
    tracker.record(makeRecord({ success: false }));
    const stats = tracker.getRouteStats("route-a");
    expect(stats?.winRate).toBe(0.5);
  });

  it("returns 0 win rate for unknown route", () => {
    expect(tracker.getWinRate("unknown")).toBe(0);
  });

  it("evicts oldest record when exceeding max", () => {
    const small = new ExecutionTracker(2);
    small.record(makeRecord({ routeKey: "r1", profit: 10n }));
    small.record(makeRecord({ routeKey: "r2", profit: 20n }));
    small.record(makeRecord({ routeKey: "r3", profit: 30n }));
    const r1Stats = small.getRouteStats("r1");
    expect(r1Stats?.totalAttempts).toBe(0);
    expect(small.summary.totalAttempts).toBe(2);
  });

  it("returns recent records", () => {
    tracker.record(makeRecord({ routeKey: "r1" }));
    tracker.record(makeRecord({ routeKey: "r2" }));
    const recent = tracker.getRecentRecords(1);
    expect(recent).toHaveLength(1);
    expect(recent[0].routeKey).toBe("r2");
  });

  it("prunes old records", () => {
    const now = Date.now();
    tracker.record(makeRecord({ routeKey: "fresh", timestamp: now }));
    tracker.record(makeRecord({ routeKey: "stale", timestamp: now - 100_000 }));
    tracker.prune(50_000);
    expect(tracker.getRouteStats("stale")).toBeUndefined();
    expect(tracker.getRouteStats("fresh")).toBeDefined();
  });
});
