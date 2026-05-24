import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { CircuitBreaker } from "./circuit_breaker.ts";

describe("CircuitBreaker", () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    vi.useFakeTimers();
    cb = new CircuitBreaker("test", { failureThreshold: 3, cooldownMs: 30_000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts closed", () => {
    expect(cb.getState()).toBe("closed");
    expect(cb.isHealthy()).toBe(true);
  });

  it("trips open after failureThreshold failures", async () => {
    cb = new CircuitBreaker("test", { failureThreshold: 3, cooldownMs: 30_000 });
    await expect(cb.execute(() => Promise.reject(new Error("fail")))).rejects.toThrow("fail");
    await expect(cb.execute(() => Promise.reject(new Error("fail")))).rejects.toThrow("fail");
    await expect(cb.execute(() => Promise.reject(new Error("fail")))).rejects.toThrow("fail");
    expect(cb.getState()).toBe("open");
    expect(cb.isHealthy()).toBe(false);

    const result = cb.execute(() => Promise.reject(new Error("should-not-call")));
    await expect(result).rejects.toThrow("Circuit breaker 'test' is open");
  });

  it("allows success after reset", () => {
    cb.reset();
    expect(cb.getState()).toBe("closed");
    expect(cb.isHealthy()).toBe(true);
  });

  it("uses fallback when open and fallback provided", async () => {
    cb = new CircuitBreaker("fb-test", { failureThreshold: 1, cooldownMs: 30_000 });
    await cb.execute(() => Promise.reject(new Error("fail"))).catch(() => {});
    const fb = vi.fn().mockResolvedValue("fallback");
    const result = await cb.execute(() => Promise.reject(new Error("fail")), fb);
    expect(result).toBe("fallback");
    expect(fb).toHaveBeenCalledOnce();
  });

  it("half-open after cooldown and closes after success", async () => {
    cb = new CircuitBreaker("half", { failureThreshold: 1, cooldownMs: 10_000 });
    await cb.execute(() => Promise.reject(new Error("fail"))).catch(() => {});
    expect(cb.getState()).toBe("open");

    vi.advanceTimersByTime(10_001);
    expect(cb.getState()).toBe("half-open");

    await cb.execute(() => Promise.resolve("ok"));
    await cb.execute(() => Promise.resolve("ok"));
    expect(cb.getState()).toBe("closed");
  });

  it("re-opens from half-open on failure", async () => {
    cb = new CircuitBreaker("half-fail", { failureThreshold: 1, cooldownMs: 10_000 });
    await cb.execute(() => Promise.reject(new Error("fail"))).catch(() => {});
    vi.advanceTimersByTime(10_001);

    await cb.execute(() => Promise.reject(new Error("fail"))).catch(() => {});
    expect(cb.getState()).toBe("open");
  });

  it("tracks failure count", async () => {
    expect(cb.getFailureCount()).toBe(0);
    await cb.execute(() => Promise.reject(new Error("fail"))).catch(() => {});
    expect(cb.getFailureCount()).toBe(1);
    cb.reset();
    expect(cb.getFailureCount()).toBe(0);
  });

  it("resets failure count on success when closed", async () => {
    await cb.execute(() => Promise.reject(new Error("fail"))).catch(() => {});
    expect(cb.getFailureCount()).toBe(1);
    await cb.execute(() => Promise.resolve("ok"));
    expect(cb.getFailureCount()).toBe(0);
  });
});
