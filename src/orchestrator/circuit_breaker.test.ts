import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CircuitBreaker, CircuitState, DEFAULT_CIRCUIT_BREAKER_OPTIONS } from "./circuit_breaker.ts";

describe("CircuitBreaker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("initial state", () => {
    it("starts in CLOSED state", () => {
      const cb = new CircuitBreaker();
      expect(cb.getState()).toBe(CircuitState.CLOSED);
    });

    it("allows execution in CLOSED state", () => {
      const cb = new CircuitBreaker();
      expect(cb.allowExecution()).toBe(true);
    });
  });

  describe("recordSuccess", () => {
    it("resets failure timestamps on success", () => {
      const cb = new CircuitBreaker({ maxConsecutiveFailures: 2, windowMs: 60_000, cooldownMs: 0 });
      cb.recordFailure();
      cb.recordFailure();
      expect(cb.getState()).toBe(CircuitState.OPEN);
      // allowExecution transitions to HALF_OPEN since cooldown is 0
      expect(cb.allowExecution()).toBe(true);
      expect(cb.getState()).toBe(CircuitState.HALF_OPEN);
      cb.recordSuccess();
      expect(cb.getState()).toBe(CircuitState.CLOSED);
      expect(cb.allowExecution()).toBe(true);
    });

    it("transitions from HALF_OPEN to CLOSED on success", () => {
      const cb = new CircuitBreaker({ maxConsecutiveFailures: 1, windowMs: 60_000, cooldownMs: 0 });
      cb.recordFailure();
      expect(cb.getState()).toBe(CircuitState.OPEN);
      // After 0ms cooldown, allowExecution transitions to HALF_OPEN
      expect(cb.allowExecution()).toBe(true);
      expect(cb.getState()).toBe(CircuitState.HALF_OPEN);
      cb.recordSuccess();
      expect(cb.getState()).toBe(CircuitState.CLOSED);
    });
  });

  describe("recordFailure", () => {
    it("remains CLOSED until threshold reached", () => {
      const cb = new CircuitBreaker({ maxConsecutiveFailures: 3, windowMs: 60_000, cooldownMs: 300_000 });
      expect(cb.recordFailure()).toBe(CircuitState.CLOSED);
      expect(cb.getState()).toBe(CircuitState.CLOSED);
      expect(cb.recordFailure()).toBe(CircuitState.CLOSED);
      expect(cb.getState()).toBe(CircuitState.CLOSED);
    });

    it("transitions to OPEN when threshold reached", () => {
      const cb = new CircuitBreaker({ maxConsecutiveFailures: 3, windowMs: 60_000, cooldownMs: 300_000 });
      cb.recordFailure();
      cb.recordFailure();
      const state = cb.recordFailure();
      expect(state).toBe(CircuitState.OPEN);
      expect(cb.getState()).toBe(CircuitState.OPEN);
    });

    it("blocks execution when OPEN", () => {
      const cb = new CircuitBreaker({ maxConsecutiveFailures: 1, windowMs: 60_000, cooldownMs: 300_000 });
      cb.recordFailure();
      expect(cb.allowExecution()).toBe(false);
    });
  });

  describe("sliding window", () => {
    it("prunes old failures outside the window", () => {
      vi.setSystemTime(0);
      const cb = new CircuitBreaker({ maxConsecutiveFailures: 3, windowMs: 60_000, cooldownMs: 300_000 });
      cb.recordFailure(); // t=0
      cb.recordFailure(); // t=0
      vi.advanceTimersByTime(61_000);
      // old failures at t=0 should be pruned
      cb.recordFailure(); // t=61000
      // only 1 failure in window, should be CLOSED
      expect(cb.getState()).toBe(CircuitState.CLOSED);
    });
  });

  describe("cooldown and half-open", () => {
    it("transitions to HALF_OPEN after cooldown and allows execution", () => {
      const cb = new CircuitBreaker({ maxConsecutiveFailures: 2, windowMs: 60_000, cooldownMs: 10_000 });
      cb.recordFailure();
      cb.recordFailure();
      expect(cb.getState()).toBe(CircuitState.OPEN);
      expect(cb.allowExecution()).toBe(false);
      vi.advanceTimersByTime(10_000);
      expect(cb.allowExecution()).toBe(true);
      expect(cb.getState()).toBe(CircuitState.HALF_OPEN);
    });

    it("reverts to OPEN if failure occurs in HALF_OPEN", () => {
      const cb = new CircuitBreaker({ maxConsecutiveFailures: 2, windowMs: 60_000, cooldownMs: 0 });
      cb.recordFailure();
      cb.recordFailure();
      expect(cb.getState()).toBe(CircuitState.OPEN);
      // cooldown 0 → transitions to HALF_OPEN on allowExecution
      expect(cb.allowExecution()).toBe(true);
      expect(cb.getState()).toBe(CircuitState.HALF_OPEN);
      // failure in HALF_OPEN should trip again
      cb.recordFailure();
      expect(cb.getState()).toBe(CircuitState.OPEN);
    });
  });

  describe("reset", () => {
    it("resets to CLOSED and clears failures", () => {
      const cb = new CircuitBreaker({ maxConsecutiveFailures: 1, windowMs: 60_000, cooldownMs: 300_000 });
      cb.recordFailure();
      expect(cb.getState()).toBe(CircuitState.OPEN);
      cb.reset();
      expect(cb.getState()).toBe(CircuitState.CLOSED);
      expect(cb.allowExecution()).toBe(true);
    });
  });

  describe("DEFAULT_CIRCUIT_BREAKER_OPTIONS", () => {
    it("has expected defaults", () => {
      expect(DEFAULT_CIRCUIT_BREAKER_OPTIONS.maxConsecutiveFailures).toBe(5);
      expect(DEFAULT_CIRCUIT_BREAKER_OPTIONS.windowMs).toBe(60_000);
      expect(DEFAULT_CIRCUIT_BREAKER_OPTIONS.cooldownMs).toBe(300_000);
    });
  });
});
