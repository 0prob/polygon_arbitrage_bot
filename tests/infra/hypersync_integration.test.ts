import { describe, it, expect, vi, beforeEach } from "vitest";
import { 
  discoverPoolsFromHasura, 
  buildStateCacheFromGraphQL, 
} from "../../src/infra/hypersync/hyperindex_graphql";

const MOCK_URL = "http://localhost:8080/v1/graphql";
const MOCK_SECRET = "admin-secret";

describe("Hypersync GraphQL Integration", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal("setTimeout", (cb: any) => cb());
  });

  it("should discover pools from Hasura correctly parsing tokens", async () => {
    const mockPoolMeta = [
      {
        id: "0x123",
        protocol: "UniswapV3",
        tokens: ["0xAAA", "0xBBB"]
      },
      {
        id: "0x456",
        protocol: "Balancer",
        tokens: JSON.stringify(["0xCCC", "0xDDD"])
      }
    ];

    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: {
          PoolMeta: mockPoolMeta
        }
      })
    })));

    const pools = await discoverPoolsFromHasura(MOCK_URL, MOCK_SECRET);

    expect(pools.length).toBeGreaterThanOrEqual(2);
    
    const pool1 = pools.find(p => p.address === "0x123");
    expect(pool1).toBeDefined();
    expect(pool1).toEqual({
      address: "0x123",
      protocol: "UniswapV3",
      tokens: ["0xaaa", "0xbbb"],
      fee: 30,
    });
    
    const pool2 = pools.find(p => p.address === "0x456");
    expect(pool2).toBeDefined();
    expect(pool2).toEqual({
      address: "0x456",
      protocol: "Balancer",
      tokens: ["0xccc", "0xddd"],
      fee: 30,
    });
  });

  it("should handle empty PoolMeta response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: {
          PoolMeta: null
        }
      })
    })));

    const pools = await discoverPoolsFromHasura(MOCK_URL, MOCK_SECRET);
    expect(pools.length).toBeGreaterThan(0); // Should return static anchors
  });

  it("should handle GraphQL errors in discoverPoolsFromHasura", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        errors: [{ message: "Some error" }]
      })
    })));

    const pools = await discoverPoolsFromHasura(MOCK_URL, MOCK_SECRET);
    expect(pools.length).toBeGreaterThan(0); // Should return static anchors on error
  });

  it("should build state cache correctly from various pool types", async () => {
    const mockData: Record<string, any> = {
      V3PoolState: [
        { id: "0xV3", sqrtPriceX96: "1000", liquidity: "5000", tick: 10 }
      ],
      BalancerPoolState: [
        { 
          id: "0xBAL", 
          poolId: "0xPOOLID", 
          balances: ["100", "200"], 
          weights: JSON.stringify(["500000000000000000", "500000000000000000"]), 
          amp: "100", 
          swapFee: "1000" 
        }
      ],
      V4PoolState: [],
      CurvePoolState: [],
      V2PoolState: [],
      DodoPoolState: [],
      WoofiPoolState: []
    };

    vi.stubGlobal("fetch", vi.fn(async (url, init: any) => {
      const body = JSON.parse(init.body);
      const query = body.query;
      
      let data: any = {};
      if (query.includes("V3PoolState")) data.V3PoolState = mockData.V3PoolState;
      if (query.includes("BalancerPoolState")) data.BalancerPoolState = mockData.BalancerPoolState;
      if (query.includes("V4PoolState")) data.V4PoolState = mockData.V4PoolState;
      if (query.includes("CurvePoolState")) data.CurvePoolState = mockData.CurvePoolState;
      if (query.includes("V2PoolState")) data.V2PoolState = mockData.V2PoolState;
      if (query.includes("DodoPoolState")) data.DodoPoolState = mockData.DodoPoolState;
      if (query.includes("WoofiPoolState")) data.WoofiPoolState = mockData.WoofiPoolState;

      return {
        ok: true,
        json: async () => ({ data })
      };
    }));

    const cache = await buildStateCacheFromGraphQL(MOCK_URL, MOCK_SECRET);

    expect(cache.has("0xv3")).toBe(true);
    expect(cache.get("0xv3")).toMatchObject({
      sqrtPriceX96: 1000n,
      liquidity: 5000n,
      tick: 10
    });

    expect(cache.has("0xbal")).toBe(true);
    expect(cache.get("0xbal")).toMatchObject({
      poolId: "0xPOOLID",
      balances: [100n, 200n],
      weights: [500000000000000000n, 500000000000000000n],
      amp: 100n,
      swapFee: 1000n
    });
  });

  it("should handle malformed JSON in parseBigIntArray through Balancer fetch", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: {
          BalancerPoolState: [
            { 
              id: "0xMAL", 
              poolId: "0xPID", 
              balances: "not json", 
              weights: [], 
              amp: null, 
              swapFee: "0" 
            }
          ]
        }
      })
    })));

    const cache = await buildStateCacheFromGraphQL(MOCK_URL, MOCK_SECRET);
    const entry = cache.get("0xmal");
    expect(entry?.balances).toEqual([]);
  });
});