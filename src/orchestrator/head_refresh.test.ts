import { describe, it, expect, vi, beforeEach } from "vitest";
import { refreshCyclePoolsOnHead } from "./head_refresh.ts";
import type { RuntimeContext } from "./boot.ts";

vi.mock("../pipeline/fetcher.ts", () => ({
  fetchMissingPoolState: vi.fn().mockResolvedValue(new Set()),
}));

vi.mock("../pipeline/tick_fetcher.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pipeline/tick_fetcher.ts")>();
  return {
    ...actual,
    fetchTicksForCyclePools: vi.fn().mockResolvedValue(1),
    collectCyclePoolAddresses: vi.fn().mockReturnValue(new Set(["0xpool1"])),
  };
});

describe("refreshCyclePoolsOnHead", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips when no cycles", async () => {
    const { fetchMissingPoolState } = await import("../pipeline/fetcher.ts");
    const ctx = {
      stateRefreshService: { Pools: [{ address: "0xpool1" }] },
      stateClient: {},
      publicClient: {},
      config: { routing: { tickFetchEnabled: true, tickWordRange: 3 } },
      logger: { debug: vi.fn() },
    } as unknown as RuntimeContext;

    await refreshCyclePoolsOnHead(ctx, new Map(), [], 50);
    expect(fetchMissingPoolState).not.toHaveBeenCalled();
  });

  it("refreshes cycle pools on new head", async () => {
    const { fetchMissingPoolState } = await import("../pipeline/fetcher.ts");
    const { fetchTicksForCyclePools } = await import("../pipeline/tick_fetcher.ts");
    const stateCache = new Map();
    const cycles = [
      {
        edges: [{ poolAddress: "0xpool1", protocol: "UNISWAP_V3" }],
        hopCount: 1,
        startToken: "0xtoken",
        logWeight: 0,
        cumulativeFeeBps: 30n,
      },
    ] as any;

    const ctx = {
      stateRefreshService: { Pools: [{ address: "0xpool1" }] },
      stateClient: { multicall: vi.fn() },
      publicClient: { multicall: vi.fn() },
      config: { routing: { tickFetchEnabled: true, tickWordRange: 3 } },
      logger: { debug: vi.fn() },
    } as unknown as RuntimeContext;

    await refreshCyclePoolsOnHead(ctx, stateCache, cycles, 50);
    expect(fetchMissingPoolState).toHaveBeenCalled();
    expect(fetchTicksForCyclePools).toHaveBeenCalled();
  });
});
