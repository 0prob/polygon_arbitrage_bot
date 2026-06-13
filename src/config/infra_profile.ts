import type { AppConfig } from "./schema.ts";

/** Resolved runtime tuning derived from RPC tier / explicit profile. */
export interface InfraProfile {
  tier: "low" | "standard";
  maxSimCycles: number;
  routeCooldownMs: number;
  enumMaxPathsScale: number;
  enumMaxPathsCap: number;
  concurrencyScale: number;
  simBatchSize: number;
  hfBudgetMs: number;
  /** Max parallel estimateGas dry-runs per HF execution batch. */
  dryRunConcurrency: number;
}

const LOW_RPS_THRESHOLD = 250;

export function resolveInfraProfile(config: AppConfig): InfraProfile {
  const rps = config.rpc.chainstackRps ?? LOW_RPS_THRESHOLD;
  const explicit = (config as AppConfig & { infraProfile?: string }).infraProfile;
  const tier =
    explicit === "low" ? "low" : explicit === "standard" ? "standard" : rps <= LOW_RPS_THRESHOLD ? "low" : "standard";

  if (tier === "low") {
    return {
      tier: "low",
      maxSimCycles: 600,
      routeCooldownMs: 12_000,
      enumMaxPathsScale: 0.8,
      enumMaxPathsCap: 8000,
      concurrencyScale: 0.5,
      simBatchSize: 25,
      hfBudgetMs: 160,
      dryRunConcurrency: 4,
    };
  }

  return {
    tier: "standard",
    maxSimCycles: 1200,
    routeCooldownMs: 5000,
    enumMaxPathsScale: 1,
    enumMaxPathsCap: Number.MAX_SAFE_INTEGER,
    concurrencyScale: 1,
    simBatchSize: 50,
    hfBudgetMs: 160,
    dryRunConcurrency: 8,
  };
}

export function scaledConcurrency(base: number, profile: InfraProfile, degraded: boolean): number {
  let c = degraded ? Math.max(10, Math.floor(base * 0.4)) : base;
  c = Math.floor(c * profile.concurrencyScale);
  return Math.max(4, c);
}
