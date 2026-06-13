import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  applyHyperSyncPacingEnv,
  getMetadataConcurrency,
  getRecommendedFullBatchSize,
  getRpmTarget,
  getTokenMetaEffectRateLimit,
} from "./pacing";

describe("pacing", () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    delete process.env.HYPERSYNC_RPM_TARGET;
    delete process.env.ENVIO_HYPERSYNC_RPM_TARGET;
  });

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it("applyHyperSyncPacingEnv sets batch size from rpm target", () => {
    const env: Record<string, string | undefined> = { HYPERSYNC_RPM_TARGET: "120" };
    applyHyperSyncPacingEnv(env);
    expect(env.ENVIO_FULL_BATCH_SIZE).toBe("1800");
    expect(env.ENVIO_HYPERSYNC_RPM_TARGET).toBe("120");
  });

  it("does not override explicit ENVIO_FULL_BATCH_SIZE", () => {
    const env: Record<string, string | undefined> = {
      HYPERSYNC_RPM_TARGET: "120",
      ENVIO_FULL_BATCH_SIZE: "999",
    };
    applyHyperSyncPacingEnv(env);
    expect(env.ENVIO_FULL_BATCH_SIZE).toBe("999");
  });

  it("scales metadata concurrency and effect rate limits with quota", () => {
    process.env.HYPERSYNC_RPM_TARGET = "200";
    expect(getRpmTarget()).toBe(200);
    expect(getRecommendedFullBatchSize()).toBe(4500);
    expect(getMetadataConcurrency()).toBe(6);
    expect(getTokenMetaEffectRateLimit().calls).toBe(500);

    process.env.HYPERSYNC_RPM_TARGET = "100";
    expect(getRecommendedFullBatchSize()).toBe(1000);
    expect(getMetadataConcurrency()).toBe(1);
    expect(getTokenMetaEffectRateLimit().calls).toBe(50);
  });
});
