import { describe, it, expect, vi } from "vitest";
import {
  collectCyclePoolAddresses,
  fetchPoolTicks,
  resetTickVersionForTests,
} from "./tick_fetcher.ts";

describe("tick_fetcher", () => {
  it("collectCyclePoolAddresses returns V3/V4 pools only", () => {
    const addrs = collectCyclePoolAddresses([
      {
        startToken: "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",
        edges: [
          {
            poolAddress: "0xaaa",
            protocol: "UNISWAP_V3",
            tokenIn: "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",
            tokenOut: "0xbbb",
            feeBps: 30n,
            zeroForOne: true,
            tokenInIdx: 0,
            tokenOutIdx: 1,
          },
          {
            poolAddress: "0xccc",
            protocol: "UNISWAP_V2",
            tokenIn: "0xbbb",
            tokenOut: "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",
            feeBps: 30n,
            zeroForOne: false,
            tokenInIdx: 0,
            tokenOutIdx: 1,
          },
        ],
        hopCount: 2,
        logWeight: 0,
        cumulativeFeeBps: 60n,
      },
    ]);
    expect(addrs.has("0xaaa")).toBe(true);
    expect(addrs.has("0xccc")).toBe(false);
  });

  it("fetchPoolTicks decodes TickLens multicall results", async () => {
    resetTickVersionForTests();
    const client = {
      multicall: vi.fn().mockResolvedValue([
        {
          status: "success",
          result: [
            { tick: -60, liquidityNet: 1_000_000n },
            { tick: 60, liquidityNet: -1_000_000n },
          ],
        },
        { status: "success", result: [] },
        { status: "success", result: [] },
        { status: "success", result: [] },
        { status: "success", result: [] },
        { status: "success", result: [] },
        { status: "success", result: [] },
      ]),
    } as any;

    const result = await fetchPoolTicks(client, "0xpool", 0, 60, 3);
    expect(result).not.toBeNull();
    expect(result!.ticks.size).toBe(2);
    expect(result!.ticks.get(-60)?.liquidityNet).toBe(1_000_000n);
    expect(result!.tickVersion).toBe(1);
    expect(result!.loadedWordMin).toBe(-3);
    expect(result!.loadedWordMax).toBe(3);
  });

  it("fetchPoolTicks returns null on multicall failure", async () => {
    const client = {
      multicall: vi.fn().mockRejectedValue(new Error("rpc fail")),
    } as any;
    const result = await fetchPoolTicks(client, "0xpool", 0, 60, 1);
    expect(result).toBeNull();
  });

  it("widenPoolTicks expands loaded tick range", async () => {
    const { widenPoolTicks, resetTickVersionForTests } = await import("./tick_fetcher.ts");
    resetTickVersionForTests();
    const stateCache = {
      data: new Map<string, Record<string, unknown>>([
        [
          "0xpool",
          { tick: 0, loadedWordMin: -3, loadedWordMax: 3, tickSpacing: 60 },
        ],
      ]),
      get(addr: string) {
        return this.data.get(addr.toLowerCase());
      },
      set(addr: string, val: Record<string, unknown>) {
        this.data.set(addr.toLowerCase(), val);
      },
    };
    const client = {
      multicall: vi.fn().mockResolvedValue([
        { status: "success", result: [{ tick: 60, liquidityNet: 1_000_000n }] },
      ]),
    } as any;
    const ok = await widenPoolTicks(client, stateCache as any, "0xpool", [{ address: "0xpool", protocol: "V3", fee: 3000 } as any]);
    expect(ok).toBe(true);
    expect(stateCache.get("0xpool")?.ticks).toBeInstanceOf(Map);
  });
});
