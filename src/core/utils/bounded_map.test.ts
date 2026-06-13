import { describe, it, expect, vi, afterEach } from "vitest";
import { BoundedMap } from "./bounded_map.ts";

describe("BoundedMap", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("liveSize excludes expired entries while size retains them until pruned", () => {
    vi.useFakeTimers();
    const map = new BoundedMap<string, number>({ maxSize: 10, ttlMs: 1000 });
    map.set("a", 1);
    map.set("b", 2);
    expect(map.size).toBe(2);
    expect(map.liveSize()).toBe(2);

    vi.advanceTimersByTime(1500);
    expect(map.size).toBe(2);
    expect(map.liveSize()).toBe(0);

    expect(map.prune()).toBe(2);
    expect(map.size).toBe(0);
    expect(map.has("a")).toBe(false);
  });
});
