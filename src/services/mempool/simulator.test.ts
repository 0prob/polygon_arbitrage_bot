import { describe, it, expect, vi } from "vitest";
import { MempoolSimulator } from "./simulator.ts";

describe("MempoolSimulator", () => {
  it("builds manual V2 override from pool state", async () => {
    const client = { call: vi.fn() } as any;
    const simulator = new MempoolSimulator({
      client,
      getPoolState: () => ({ reserve0: 1_000_000n, reserve1: 2_000_000n, initialized: true }),
    });

    const result = await simulator.buildOverride(
      "0xpool1" as `0x${string}`,
      "uniswap_v2_pool",
      "0x0000000000000000000000000000000000000001" as `0x${string}`,
      "0x0000000000000000000000000000000000000002" as `0x${string}`,
      6n,
      { to: "0xpool1", data: "0x", value: "0x0" },
      { zeroForOne: true },
    );

    expect(result.success).toBe(true);
    expect(result.method).toBe("manual");
    expect(result.affectedPools).toEqual(["0xpool1"]);
    expect(result.stateOverride?.["0xpool1"]?.stateDiff).toBeDefined();
  });
});
