import { describe, it, expect } from "vitest";
import { TierManager } from "./tier_manager.ts";
import type { CircuitBreaker } from "./circuit_breaker.ts";
import type { HyperIndexMonitor } from "./hyperindex_monitor.ts";

function healthyCB(): CircuitBreaker {
  return { isHealthy: () => true } as CircuitBreaker;
}

function unhealthyCB(): CircuitBreaker {
  return { isHealthy: () => false } as CircuitBreaker;
}

function healthyHI(): HyperIndexMonitor {
  return { isHealthy: () => true } as HyperIndexMonitor;
}

function unhealthyHI(): HyperIndexMonitor {
  return { isHealthy: () => false } as HyperIndexMonitor;
}

describe("TierManager", () => {
  it("green when everything healthy", () => {
    const tm = new TierManager(healthyCB(), healthyCB(), healthyHI());
    expect(tm.assess()).toBe("green");
    expect(tm.isFull()).toBe(true);
    expect(tm.shouldDiscover()).toBe(true);
    expect(tm.shouldExecute()).toBe(true);
    expect(tm.shouldEnumerate()).toBe(true);
    expect(tm.shouldSimulate()).toBe(true);
  });

  it("yellow when only hyperindex is unhealthy", () => {
    const tm = new TierManager(healthyCB(), healthyCB(), unhealthyHI());
    expect(tm.assess()).toBe("yellow");
    expect(tm.shouldDiscover()).toBe(true);
    expect(tm.shouldExecute()).toBe(true);
  });

  it("orange when only hasura is unhealthy", () => {
    const tm = new TierManager(healthyCB(), unhealthyCB(), healthyHI());
    expect(tm.assess()).toBe("orange");
    expect(tm.shouldDiscover()).toBe(false);
  });

  it("red when both hasura and hyperindex are unhealthy", () => {
    const tm = new TierManager(healthyCB(), unhealthyCB(), unhealthyHI());
    expect(tm.assess()).toBe("red");
    expect(tm.shouldDiscover()).toBe(false);
    expect(tm.shouldSimulate()).toBe(false);
  });

  it("black when RPC is unhealthy", () => {
    const tm = new TierManager(unhealthyCB(), healthyCB(), healthyHI());
    expect(tm.assess()).toBe("black");
    expect(tm.shouldExecute()).toBe(false);
    expect(tm.shouldDiscover()).toBe(false);
    expect(tm.shouldEnumerate()).toBe(false);
    expect(tm.shouldSimulate()).toBe(false);
    expect(tm.shouldPollState()).toBe(false);
  });

  it("label returns descriptive string", () => {
    const tm = new TierManager(healthyCB(), healthyCB(), healthyHI());
    tm.assess();
    expect(tm.label()).toContain("GREEN");
    expect(tm.label()).toContain("healthy");
  });
});
