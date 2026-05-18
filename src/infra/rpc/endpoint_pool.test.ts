import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RpcEndpoint, RpcEndpointPool } from "./endpoint_pool.ts";

vi.mock("viem", () => ({
  createPublicClient: vi.fn(() => ({
    getBlockNumber: vi.fn(),
  })),
  http: vi.fn(() => "mock_transport"),
}));

vi.mock("viem/chains", () => ({
  polygon: { id: 137, name: "Polygon" },
}));

function makePool(urls: string[]) {
  return new RpcEndpointPool({ urls });
}

describe("RpcEndpoint", () => {
  it("creates endpoint with default health state", () => {
    const ep = new RpcEndpoint("https://rpc.example.com");
    expect(ep.url).toBe("https://rpc.example.com");
    expect(ep.latencyMs).toBe(Infinity);
    expect(ep.consecutiveErrors).toBe(0);
    expect(ep.rateLimitedUntil).toBe(0);
    expect(ep.inFlight).toBe(0);
    expect(ep.isRateLimited()).toBe(false);
    expect(ep.isCoolingDown()).toBe(false);
    expect(ep.isUnavailable()).toBe(false);
  });

  it("ensures https when http is provided", () => {
    const ep = new RpcEndpoint("http://rpc.example.com");
    expect(ep.url).toBe("https://rpc.example.com");
  });

  it("marks rate limited state", () => {
    const ep = new RpcEndpoint("https://rpc.example.com");
    ep.markRateLimited("eth_call");
    expect(ep.isRateLimited()).toBe(true);
    expect(ep.consecutiveErrors).toBe(1);
  });

  it("marks error state", () => {
    const ep = new RpcEndpoint("https://rpc.example.com");
    ep.markError("eth_call");
    expect(ep.isCoolingDown()).toBe(true);
    expect(ep.consecutiveErrors).toBe(1);
  });

  it("resets consecutive errors on success", () => {
    const ep = new RpcEndpoint("https://rpc.example.com");
    ep.markError("eth_call");
    ep.markError("eth_call");
    expect(ep.consecutiveErrors).toBe(2);
    ep.markSuccess();
    expect(ep.consecutiveErrors).toBe(0);
  });

  it("clears cooldown on success when not in cooldown", () => {
    const ep = new RpcEndpoint("https://rpc.example.com");
    ep.errorCooldownUntil = 0;
    ep.rateLimitedUntil = 0;
    ep.markSuccess();
    expect(ep.isCoolingDown()).toBe(false);
  });

  it("tracks method unavailability", () => {
    const ep = new RpcEndpoint("https://rpc.example.com");
    expect(ep.isMethodUnavailable("eth_getLogs")).toBe(false);
    ep.methodUnavailableUntil.set("eth_getLogs", Date.now() + 60_000);
    expect(ep.isMethodUnavailable("eth_getLogs")).toBe(true);
  });

  it("becomes unavailable after max consecutive errors", () => {
    const ep = new RpcEndpoint("https://rpc.example.com");
    for (let i = 0; i < 5; i++) {
      ep.markError();
    }
    expect(ep.isUnavailable()).toBe(true);
  });
});

describe("RpcEndpointPool", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("throws with no urls", () => {
    const make = () => makePool([]);
    expect(make).toThrow("at least one RPC URL");
  });

  it("creates endpoints from urls", () => {
    const pool = makePool(["https://rpc1.example.com", "https://rpc2.example.com"]);
    expect(pool.endpoints).toHaveLength(2);
    expect(pool.endpoints[0].url).toBe("https://rpc1.example.com");
    expect(pool.endpoints[1].url).toBe("https://rpc2.example.com");
  });

  it("selects best endpoint by lowest latency", () => {
    const pool = makePool(["https://rpc1.example.com", "https://rpc2.example.com"]);
    pool.endpoints[0].latencyMs = 100;
    pool.endpoints[1].latencyMs = 50;
    const best = pool.getBestEndpoint();
    expect(best.url).toBe("https://rpc2.example.com");
  });

  it("prefers lower in-flight when latencies are equal", () => {
    const pool = makePool(["https://rpc1.example.com", "https://rpc2.example.com"]);
    pool.endpoints[0].latencyMs = 100;
    pool.endpoints[1].latencyMs = 100;
    pool.endpoints[0].inFlight = 5;
    pool.endpoints[1].inFlight = 1;
    const best = pool.getBestEndpoint();
    expect(best.url).toBe("https://rpc2.example.com");
  });

  it("avoids rate-limited endpoints", () => {
    const pool = makePool(["https://rpc1.example.com", "https://rpc2.example.com"]);
    pool.endpoints[0].latencyMs = 10;
    pool.endpoints[1].latencyMs = 100;
    pool.endpoints[0].rateLimitedUntil = Date.now() + 60_000;
    const best = pool.getBestEndpoint();
    expect(best.url).toBe("https://rpc2.example.com");
  });

  it("avoids cooling-down endpoints", () => {
    const pool = makePool(["https://rpc1.example.com", "https://rpc2.example.com"]);
    pool.endpoints[0].latencyMs = 10;
    pool.endpoints[1].latencyMs = 100;
    pool.endpoints[0].errorCooldownUntil = Date.now() + 5_000;
    const best = pool.getBestEndpoint();
    expect(best.url).toBe("https://rpc2.example.com");
  });

  it("avoids method-unavailable endpoints", () => {
    const pool = makePool(["https://rpc1.example.com", "https://rpc2.example.com"]);
    pool.endpoints[0].latencyMs = 10;
    pool.endpoints[1].latencyMs = 100;
    pool.endpoints[0].methodUnavailableUntil.set("eth_call", Date.now() + 60_000);
    const best = pool.getBestEndpoint("eth_call");
    expect(best.url).toBe("https://rpc2.example.com");
  });

  it("picks earliest-recovering endpoint when all are cooling", () => {
    const pool = makePool(["https://rpc1.example.com", "https://rpc2.example.com"]);
    pool.endpoints[0].latencyMs = 10;
    pool.endpoints[1].latencyMs = 50;
    pool.endpoints[0].errorCooldownUntil = Date.now() + 10_000;
    pool.endpoints[1].errorCooldownUntil = Date.now() + 2_000;
    const best = pool.getBestEndpoint();
    expect(best.url).toBe("https://rpc2.example.com");
  });

  it("picks earliest-recovering endpoint when all are rate-limited", () => {
    const pool = makePool(["https://rpc1.example.com", "https://rpc2.example.com"]);
    pool.endpoints[0].latencyMs = 10;
    pool.endpoints[1].latencyMs = 50;
    pool.endpoints[0].rateLimitedUntil = Date.now() + 10_000;
    pool.endpoints[1].rateLimitedUntil = Date.now() + 2_000;
    const best = pool.getBestEndpoint();
    expect(best.url).toBe("https://rpc2.example.com");
  });

  it("checkout increments in-flight and release decrements it", () => {
    const pool = makePool(["https://rpc1.example.com"]);
    const ep = pool.checkoutBestEndpoint();
    expect(ep.inFlight).toBe(1);
    pool.releaseEndpoint(ep.url);
    expect(ep.inFlight).toBe(0);
  });

  it("markMethodUnavailable for non-fundamental method sets cooldown", () => {
    const pool = makePool(["https://rpc1.example.com"]);
    const ep = pool.endpoints[0];
    pool.markMethodUnavailable(ep.url, "eth_getLogs");
    expect(ep.isMethodUnavailable("eth_getLogs")).toBe(true);
  });

  it("markMethodUnavailable for eth_call calls markError instead", () => {
    const pool = makePool(["https://rpc1.example.com"]);
    const ep = pool.endpoints[0];
    const spy = vi.spyOn(ep, "markError");
    pool.markMethodUnavailable(ep.url, "eth_call");
    expect(spy).toHaveBeenCalled();
    expect(ep.isMethodUnavailable("eth_call")).toBe(false);
  });

  it("markAuthFailed sets long cooldown", () => {
    const pool = makePool(["https://rpc1.example.com"]);
    const ep = pool.endpoints[0];
    pool.markAuthFailed(ep.url);
    expect(ep.errorCooldownUntil).toBeGreaterThan(Date.now() + 3_500_000);
  });

  it("start and stop manage probe interval", () => {
    const pool = makePool(["https://rpc1.example.com", "https://rpc2.example.com"]);
    pool.start();
    expect((pool as any)._probeInterval).not.toBeNull();
    pool.stop();
    expect((pool as any)._probeInterval).toBeNull();
  });

  it("does not double-start probe interval", () => {
    const pool = makePool(["https://rpc1.example.com"]);
    pool.start();
    const first = (pool as any)._probeInterval;
    pool.start();
    expect((pool as any)._probeInterval).toBe(first);
    pool.stop();
  });
});
