import { describe, it, expect } from "vitest";
import { warmupStateCache } from "./warmup.ts";
import type { PoolMeta } from "../../core/types/pool.ts";
import type { Address } from "../../core/types/common.ts";

describe("warmupStateCache", () => {
  it("fetches hub-adjacent V2 pools first", async () => {
    const WETH = "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619" as Address;
    const USDC = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174" as Address;
    const pool: PoolMeta = {
      address: "0xabc" as Address,
      protocol: "UNISWAP_V2",
      token0: WETH,
      token1: USDC,
      tokens: [WETH, USDC],
      status: "active",
    };
    const fetchMock = async () => ({ reserve0: 100n, reserve1: 200n });
    const result = await warmupStateCache([pool], [WETH, USDC], fetchMock);
    expect(result.size).toBe(1);
    expect(result.get("0xabc")?.reserve0).toBe(100n);
  });
});
