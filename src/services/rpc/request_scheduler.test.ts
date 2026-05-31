import { describe, it, expect } from "bun:test";
import { RequestScheduler, RequestPriority } from "./request_scheduler.ts";

describe("RequestScheduler", () => {
  it("should execute requests immediately when tokens are available", async () => {
    const scheduler = new RequestScheduler(100);
    const result = await scheduler.acquire(RequestPriority.HIGH, async () => "ok");
    expect(result).toBe("ok");
  });

  it("should respect priority ordering when tokens are scarce", async () => {
    const scheduler = new RequestScheduler(2);
    const order: number[] = [];
    const p1 = scheduler.acquire(RequestPriority.HIGH, async () => {
      order.push(1);
    });
    const p2 = scheduler.acquire(RequestPriority.LOW, async () => {
      order.push(2);
    });
    const p3 = scheduler.acquire(RequestPriority.CRITICAL, async () => {
      order.push(3);
    });
    await Promise.all([p1, p2, p3]);
    // CRITICAL is dequeued first (highest priority), then HIGH, then LOW
    expect(order[0]).toBe(3);
    expect(order[1]).toBe(1);
    expect(order[2]).toBe(2);
  });

  it("should not exceed capacity", async () => {
    const rps = 50;
    const scheduler = new RequestScheduler(rps);
    const started = Date.now();
    const count = 120;
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < count; i++) {
      promises.push(scheduler.acquire(RequestPriority.LOW, async () => "ok"));
    }
    await Promise.all(promises);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThan(800);
  });

  it("should provide metrics", () => {
    const scheduler = new RequestScheduler(100);
    const metrics = scheduler.getMetrics();
    expect(metrics.capacity).toBe(100);
    expect(metrics.used).toBe(0);
    expect(metrics.pending).toEqual([0, 0, 0]);
  });
});
