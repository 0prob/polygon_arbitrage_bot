import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StateRefreshService } from "./state_refresh.ts";
import type { RuntimeContext } from "../orchestrator/boot.ts";
import * as graphql from "../infra/hypersync/hyperindex_graphql.ts";
import { HasuraProgressSubscriber } from "../infra/hypersync/hasura_progress_subscriber.ts";

const subscriberInstance = vi.hoisted(() => ({
  setProgressHandler: vi.fn(),
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../infra/hypersync/hasura_progress_subscriber.ts", () => {
  class MockHasuraProgressSubscriber {
    setProgressHandler = subscriberInstance.setProgressHandler;
    start = subscriberInstance.start;
    stop = subscriberInstance.stop;
  }
  return { HasuraProgressSubscriber: MockHasuraProgressSubscriber };
});

function mockCtx(): RuntimeContext {
  return {
    config: {
      hasuraUrl: "http://localhost/graphql",
      hasuraSecret: "secret",
      discoveryIntervalMs: 60000,
      execution: { chainId: 137 },
      rpc: { chainstackRps: 1000 },
    },
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    stateCache: {
      get: vi.fn(),
      set: vi.fn(),
      has: vi.fn().mockReturnValue(false),
      size: 0,
      liveSize: vi.fn().mockReturnValue(0),
      prune: vi.fn().mockReturnValue(0),
      keys: vi.fn().mockReturnValue([][Symbol.iterator]()),
    },
    hasuraCircuit: {
      execute: vi.fn().mockImplementation(async (fn: () => Promise<unknown>) => fn()),
    },
    tierManager: { shouldDiscover: vi.fn().mockReturnValue(true) },
    mempoolService: { setKnownPools: vi.fn() },
    publicClient: {},
    stateClient: {},
    hyperIndexMonitor: { updateSyncedBlock: vi.fn() },
  } as unknown as RuntimeContext;
}

describe("StateRefreshService", () => {
  beforeEach(() => {
    subscriberInstance.setProgressHandler.mockClear();
    subscriberInstance.start.mockClear();
    subscriberInstance.stop.mockClear();
    vi.spyOn(graphql, "discoverPoolsFromHasura").mockResolvedValue({ pools: [], maxBlock: 0 });
    vi.spyOn(graphql, "fetchTokenMetasFromHasura").mockResolvedValue(new Map());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it("starts Hasura progress subscriber on start()", async () => {
    const ctx = mockCtx();
    const service = new StateRefreshService(ctx);
    vi.spyOn(service as any, "runPoolDiscovery").mockResolvedValue(undefined);

    await service.start();

    expect(HasuraProgressSubscriber).toBeDefined();
    expect(subscriberInstance.setProgressHandler).toHaveBeenCalled();
    expect(subscriberInstance.start).toHaveBeenCalled();

    await service.stop();
    expect(subscriberInstance.stop).toHaveBeenCalled();
  });

  it("runLfStateRefresh does not poll IndexerProgress (subscription owns progress)", async () => {
    const fetchSpy = vi.spyOn(graphql, "fetchIndexerProgressFromHasura");
    const ctx = mockCtx();
    const service = new StateRefreshService(ctx);

    await Promise.all([service.runLfStateRefresh(), service.runLfStateRefresh()]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("schedules discovery when indexer progress advances", async () => {
    vi.useFakeTimers();
    const ctx = mockCtx();
    const service = new StateRefreshService(ctx);
    const discoverySpy = vi.spyOn(service as any, "runPoolDiscovery").mockResolvedValue(undefined);

    (service as any).scheduleProgressDiscovery(1000);
    expect(discoverySpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2000);
    expect(discoverySpy).toHaveBeenCalledTimes(1);

    discoverySpy.mockClear();
    (service as any).scheduleProgressDiscovery(1010);
    expect(discoverySpy).not.toHaveBeenCalled();

    (service as any).scheduleProgressDiscovery(1100);
    await vi.advanceTimersByTimeAsync(2000);
    expect(discoverySpy).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });
});
