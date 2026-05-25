import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QuarantineManager, computeBackoff } from "./quarantine.ts";

describe("computeBackoff", () => {
  it("returns base delay for first attempt", () => {
    expect(computeBackoff(1)).toBe(1000);
  });

  it("doubles each attempt", () => {
    expect(computeBackoff(2)).toBe(2000);
    expect(computeBackoff(3)).toBe(4000);
    expect(computeBackoff(4)).toBe(8000);
  });

  it("caps at max delay", () => {
    expect(computeBackoff(9)).toBe(256_000);
    expect(computeBackoff(10)).toBe(300_000);
    expect(computeBackoff(20)).toBe(300_000);
  });
});

describe("QuarantineManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts empty", () => {
    const qm = new QuarantineManager();
    expect(qm.size).toBe(0);
    expect(qm.isQuarantined("route1")).toBe(false);
  });

  it("quarantines a route with backoff", () => {
    const qm = new QuarantineManager();
    qm.add("route1", "error1");
    expect(qm.isQuarantined("route1")).toBe(true);
    expect(qm.getEntry("route1")?.attempt).toBe(1);
  });

  it("increases attempt count on repeated failures", () => {
    const qm = new QuarantineManager();
    qm.add("route1", "error1");
    qm.add("route1", "error2");
    expect(qm.getEntry("route1")?.attempt).toBe(2);
    const entry = qm.getEntry("route1")!;
    expect(entry.nextRetry).toBe(Date.now() + 2000);
  });

  it("releases route after backoff expires", () => {
    const qm = new QuarantineManager();
    qm.add("route1", "error1");
    expect(qm.isQuarantined("route1")).toBe(true);
    // Advance past the 1s backoff
    vi.advanceTimersByTime(1001);
    expect(qm.isQuarantined("route1")).toBe(false);
  });

  it("clears quarantine on success", () => {
    const qm = new QuarantineManager();
    qm.add("route1", "error1");
    expect(qm.isQuarantined("route1")).toBe(true);
    qm.recordSuccess("route1");
    expect(qm.isQuarantined("route1")).toBe(false);
  });

  it("prunes expired entries", () => {
    const qm = new QuarantineManager();
    qm.add("route1", "error1");
    qm.add("route2", "error2");
    vi.advanceTimersByTime(500);
    qm.prune();
    expect(qm.size).toBe(2);
    vi.advanceTimersByTime(501);
    qm.prune();
    expect(qm.size).toBe(0);
  });

  it("enforces max entries limit", () => {
    const qm = new QuarantineManager();
    for (let i = 0; i < 10001; i++) {
      qm.add(`route${i}`, "error");
    }
    expect(qm.size).toBeLessThanOrEqual(10000);
  });
});
