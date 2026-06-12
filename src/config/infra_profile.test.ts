import { describe, it, expect } from "vitest";
import { resolveInfraProfile, scaledConcurrency } from "./infra_profile.ts";
import { DEFAULTS } from "./defaults.ts";
import type { AppConfig } from "./schema.ts";

function cfg(rps: number): AppConfig {
  return {
    ...DEFAULTS,
    rpc: { ...DEFAULTS.rpc, executionRpcUrl: "http://localhost", chainstackRps: rps },
    execution: { ...DEFAULTS.execution, executorAddress: "0x1", privateKey: "0x" + "1".repeat(64) },
  } as AppConfig;
}

describe("resolveInfraProfile", () => {
  it("selects low tier when RPS at threshold", () => {
    const p = resolveInfraProfile(cfg(250));
    expect(p.tier).toBe("low");
    expect(p.maxSimCycles).toBe(600);
    expect(p.routeCooldownMs).toBe(12_000);
  });

  it("selects standard tier above threshold", () => {
    const p = resolveInfraProfile(cfg(500));
    expect(p.tier).toBe("standard");
    expect(p.maxSimCycles).toBe(1200);
  });

  it("scales concurrency down when degraded", () => {
    const profile = resolveInfraProfile(cfg(500));
    expect(scaledConcurrency(75, profile, true)).toBeLessThan(scaledConcurrency(75, profile, false));
  });
});
