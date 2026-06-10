import { describe, expect, test, beforeEach, vi, afterEach } from "vitest";
import { BoundedMap } from "./bounded_map.ts";

describe("BoundedMap", () => {
  let map: BoundedMap<string, number>;

  beforeEach(() => {
    vi.useFakeTimers();
    map = new BoundedMap<string, number>({ maxSize: 3, ttlMs: 1000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("get/set basic operations", () => {
    map.set("a", 1);
    expect(map.get("a")).toBe(1);
    expect(map.has("a")).toBe(true);
  });

  test("expired entries are not returned", () => {
    map.set("a", 1);
    vi.advanceTimersByTime(1500);
    expect(map.get("a")).toBeUndefined();
    expect(map.has("a")).toBe(false);
  });

  test("evicts oldest when over maxSize", () => {
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);
    map.set("d", 4);
    expect(map.get("a")).toBeUndefined();
    expect(map.get("b")).toBe(2);
    expect(map.get("c")).toBe(3);
    expect(map.get("d")).toBe(4);
    expect(map.size).toBe(3);
  });

  test("set refreshes TTL for existing key", () => {
    map.set("a", 1);
    vi.advanceTimersByTime(900);
    map.set("a", 2);
    vi.advanceTimersByTime(200);
    expect(map.get("a")).toBe(2);
  });

  test("prune removes expired entries", () => {
    map.set("a", 1);
    map.set("b", 2);
    vi.advanceTimersByTime(500);
    map.set("c", 3);
    vi.advanceTimersByTime(600);
    expect(map.prune()).toBe(2);
    expect(map.size).toBe(1);
    expect(map.get("c")).toBe(3);
  });

  test("delete removes entry", () => {
    map.set("a", 1);
    map.delete("a");
    expect(map.get("a")).toBeUndefined();
    expect(map.size).toBe(0);
  });

  test("clear removes all entries", () => {
    map.set("a", 1);
    map.set("b", 2);
    map.clear();
    expect(map.size).toBe(0);
  });

  test("forEach only iterates live entries", () => {
    map.set("a", 1);
    map.set("b", 2);
    vi.advanceTimersByTime(1500);
    map.set("c", 3);
    const results: [string, number][] = [];
    map.forEach((v, k) => results.push([k, v]));
    expect(results).toEqual([["c", 3]]);
  });

  test("snapshot returns only live entries", () => {
    map.set("a", 1);
    map.set("b", 2);
    vi.advanceTimersByTime(1500);
    map.set("c", 3);
    const snap = map.snapshot();
    expect(snap.size).toBe(1);
    expect(snap.get("c")).toBe(3);
  });

  test("entries() only yields live entries", () => {
    map.set("a", 1);
    map.set("b", 2);
    vi.advanceTimersByTime(1500);
    map.set("c", 3);
    const results: [string, number][] = Array.from(map.entries());
    expect(results.length).toBe(1);
    expect(results[0]).toEqual(["c", 3]);
  });
});
