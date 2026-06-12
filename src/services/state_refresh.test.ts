import { describe, it, expect, vi } from "vitest";
import { StateRefreshService } from "./state_refresh.ts";
import type { RuntimeContext } from "../orchestrator/boot.ts";

function mockCtx(): RuntimeContext {
  return {
    config: {
      hasuraUrl: "http://localhost/graphql",
      hasuraSecret: "secret",
      discoveryIntervalMs: 60000,
      rpc: { chainstackRps: 1000 },
    },
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    stateCache: {
      get: vi.fn(),
      set: vi.fn(),
      has: vi.fn().mockReturnValue(false),
      size: 0,
    },
    hasuraCircuit: {
      execute: vi.fn().mockImplementation(async (fn: () => Promise<unknown>) => {
        await new Promise((r) => setTimeout(r, 30));
        return fn();
      }),
    },
    tierManager: { shouldDiscover: vi.fn().mockReturnValue(true) },
    mempoolService: { setKnownPools: vi.fn() },
    publicClient: {},
    stateClient: {},
    hyperIndexMonitor: { updateSyncedBlock: vi.fn() },
  } as unknown as RuntimeContext;
}

vi.mock("../infra/hypersync/hyperindex_graphql.ts", () => ({
  buildStateCacheFromGraphQL: vi.fn().mockResolvedValue({ stateCache: new Map(), maxSeenBlock: 1 }),
  fetchIndexerProgressFromHasura: vi.fn().mockResolvedValue({ lastProcessedBlock: 1 }),
  discoverPoolsFromHasura: vi.fn().mockResolvedValue([]),
  fetchTokenMetasFromHasura: vi.fn().mockResolvedValue(new Map()),
}));

describe("StateRefreshService", () => {
  it("does not create a dedicated lfTimer on start", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const ctx = mockCtx();
    const service = new StateRefreshService(ctx);

    vi.spyOn(service, "runLfStateRefresh").mockResolvedValue(undefined);
    vi.spyOn(service as any, "runPoolDiscovery").mockResolvedValue(undefined);

    await service.start();
    const lfTimerCalls = setIntervalSpy.mock.calls.filter((args) => args[1] === 1000);
    expect(lfTimerCalls.length).toBe(0);

    await service.stop();
    setIntervalSpy.mockRestore();
  });

  it("runLfStateRefresh ignores overlapping calls", async () => {
    const ctx = mockCtx();
    const service = new StateRefreshService(ctx);
    const { buildStateCacheFromGraphQL } = await import("../infra/hypersync/hyperindex_graphql.ts");

    await Promise.all([service.runLfStateRefresh(), service.runLfStateRefresh()]);
    expect(buildStateCacheFromGraphQL).toHaveBeenCalledTimes(1);
  });
});
