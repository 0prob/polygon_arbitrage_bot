/**
 * Handler tests using createTestIndexer() — Envio's built-in test harness.
 *
 * Docs: https://docs.envio.dev/docs/HyperIndex/testing
 *
 * Tests run fully in-process (no network, no Docker). Use `bun run test`.
 *
 * The IndexerProgressHistorical onBlock handler registers a range
 * [start_block, realtimeStart-1]. Setting INDEXER_PROGRESS_REALTIME_START
 * = chainStart collapses that range to empty so it never conflicts with
 * simulate endBlock.
 */

// Must be set before any envio handler module is evaluated (top of file).
process.env.INDEXER_PROGRESS_REALTIME_START = "5024576";

import { describe, it, expect, vi } from "vitest";

vi.mock("../effects/rpc_client", () => ({
  publicClient: {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "_I_") return 1n;
      if (functionName === "_K_") return 1n;
      if (functionName === "_BASE_RESERVE_") return 100n;
      if (functionName === "_QUOTE_RESERVE_") return 200n;
      if (functionName === "_BASE_TARGET_") return 100n;
      if (functionName === "_QUOTE_TARGET_") return 200n;
      if (functionName === "_R_STATUS_") return 0;
      if (functionName === "_LP_FEE_RATE_") return 10n;
      if (functionName === "_MT_FEE_RATE_") return 20n;
      if (functionName === "decimals") return 18;
      return 0n;
    },
  },
}));

import { createTestIndexer } from "envio";

// Well-known Quickswap V2 factory address (registered in config.yaml)
const QUICKSWAP_V2 = "0x5757371414417b8c6caad45baef941abc7d3ab32";
// Well-known Uniswap V3 factory address (registered in config.yaml)
const UNISWAP_V3 = "0x1f98431c8ad98523631ae4a59f267346ea31f984";

// Stable tokens — guaranteed in STATIC_TOKEN_DECIMALS (no RPC needed in tests)
const WMATIC = "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270";
const USDC = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";
const WETH = "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619";
const USDT = "0xc2132d05d31c914a87c6611c10748aeb04b58e8f";

// Fake pair/pool addresses
const PAIR_ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const POOL_ADDR = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

// Block number for simulate events — must be >= realtimeStart (5024576).
const SIM_BLOCK = 5_100_000;

describe("V2Factory.PairCreated", () => {
  it("creates PoolMeta and TokenMeta for a valid pair", async () => {
    const indexer = createTestIndexer();

    const _result = await indexer.process({
      chains: {
        137: {
          simulate: [
            {
              contract: "V2Factory",
              event: "PairCreated",
              srcAddress: QUICKSWAP_V2,
              block: { number: SIM_BLOCK },
              params: {
                token0: WMATIC,
                token1: USDC,
                pair: PAIR_ADDR,
                _3: 1n,
              },
            },
          ],
        },
      },
    });

    // PoolMeta should be created for the pair
    const pool = await indexer.PoolMeta.get(PAIR_ADDR);
    expect(pool).toBeDefined();
    expect(pool?.protocol).toBe("QUICKSWAP_V2");
    expect(pool?.fee).toBe(30);
    expect(pool?.tokens).toEqual([WMATIC, USDC]);

    // TokenMeta for both tokens should be set with correct decimals
    const t0 = await indexer.TokenMeta.get(WMATIC);
    const t1 = await indexer.TokenMeta.get(USDC);
    expect(t0?.decimals).toBe(18); // WMATIC = 18
    expect(t1?.decimals).toBe(6); // USDC = 6
  });

  it("ignores pairs where token0 === factory address (garbage guard)", async () => {
    const indexer = createTestIndexer();

    await indexer.process({
      chains: {
        137: {
          simulate: [
            {
              contract: "V2Factory",
              event: "PairCreated",
              srcAddress: QUICKSWAP_V2,
              block: { number: SIM_BLOCK },
              params: {
                token0: QUICKSWAP_V2, // token is the factory itself — garbage
                token1: USDC,
                pair: PAIR_ADDR,
                _3: 1n,
              },
            },
          ],
        },
      },
    });

    const pool = await indexer.PoolMeta.get(PAIR_ADDR);
    expect(pool).toBeUndefined();
  });

  it("ignores pairs with zero address token (garbage guard)", async () => {
    const ZERO = "0x0000000000000000000000000000000000000000";
    const indexer = createTestIndexer();

    await indexer.process({
      chains: {
        137: {
          simulate: [
            {
              contract: "V2Factory",
              event: "PairCreated",
              srcAddress: QUICKSWAP_V2,
              block: { number: SIM_BLOCK },
              params: {
                token0: ZERO,
                token1: USDC,
                pair: PAIR_ADDR,
                _3: 1n,
              },
            },
          ],
        },
      },
    });

    const pool = await indexer.PoolMeta.get(PAIR_ADDR);
    expect(pool).toBeUndefined();
  });

  it("uses UNKNOWN_V2 protocol for unregistered factory", async () => {
    const UNKNOWN_FACTORY = "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead";
    const indexer = createTestIndexer();

    await indexer.process({
      chains: {
        137: {
          simulate: [
            {
              contract: "V2Factory",
              event: "PairCreated",
              srcAddress: UNKNOWN_FACTORY,
              block: { number: SIM_BLOCK },
              params: {
                token0: WMATIC,
                token1: USDT,
                pair: PAIR_ADDR,
                _3: 1n,
              },
            },
          ],
        },
      },
    });

    const pool = await indexer.PoolMeta.get(PAIR_ADDR);
    expect(pool?.protocol).toBe("UNKNOWN_V2");
  });
});

describe("V3Factory.PoolCreated", () => {
  it("creates PoolMeta with fee and tickSpacing for a valid V3 pool", async () => {
    const indexer = createTestIndexer();

    const _result = await indexer.process({
      chains: {
        137: {
          simulate: [
            {
              contract: "V3Factory",
              event: "PoolCreated",
              srcAddress: UNISWAP_V3,
              block: { number: SIM_BLOCK },
              params: {
                token0: WETH,
                token1: USDC,
                fee: 500n,
                tickSpacing: 10n,
                pool: POOL_ADDR,
              },
            },
          ],
        },
      },
    });

    const pool = await indexer.PoolMeta.get(POOL_ADDR);
    expect(pool).toBeDefined();
    expect(pool?.protocol).toBe("UNISWAP_V3");
    expect(pool?.fee).toBe(500);
    expect(pool?.tickSpacing).toBe(10);
    expect(pool?.tokens).toEqual([WETH, USDC]);

    const t0 = await indexer.TokenMeta.get(WETH);
    const t1 = await indexer.TokenMeta.get(USDC);
    expect(t0?.decimals).toBe(18);
    expect(t1?.decimals).toBe(6);
  });

  it("ignores pools where token0 === factory address", async () => {
    const indexer = createTestIndexer();

    await indexer.process({
      chains: {
        137: {
          simulate: [
            {
              contract: "V3Factory",
              event: "PoolCreated",
              srcAddress: UNISWAP_V3,
              block: { number: SIM_BLOCK },
              params: {
                token0: UNISWAP_V3, // factory address as token = garbage
                token1: USDC,
                fee: 3000n,
                tickSpacing: 60n,
                pool: POOL_ADDR,
              },
            },
          ],
        },
      },
    });

    const pool = await indexer.PoolMeta.get(POOL_ADDR);
    expect(pool).toBeUndefined();
  });

  it("registers pool address dynamically (contractRegister)", async () => {
    const indexer = createTestIndexer();

    await indexer.process({
      chains: {
        137: {
          simulate: [
            {
              contract: "V3Factory",
              event: "PoolCreated",
              srcAddress: UNISWAP_V3,
              block: { number: SIM_BLOCK },
              params: {
                token0: WETH,
                token1: USDT,
                fee: 3000n,
                tickSpacing: 60n,
                pool: POOL_ADDR,
              },
            },
          ],
        },
      },
    });

    expect(indexer.chains[137].UniswapV3Pool.addresses).toContain(POOL_ADDR);
  });

  it("uses UNKNOWN_V3 protocol for unregistered factory", async () => {
    const UNKNOWN_FACTORY = "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead";
    const indexer = createTestIndexer();

    await indexer.process({
      chains: {
        137: {
          simulate: [
            {
              contract: "V3Factory",
              event: "PoolCreated",
              srcAddress: UNKNOWN_FACTORY,
              block: { number: SIM_BLOCK },
              params: {
                token0: WETH,
                token1: WMATIC,
                fee: 500n,
                tickSpacing: 10n,
                pool: POOL_ADDR,
              },
            },
          ],
        },
      },
    });

    const pool = await indexer.PoolMeta.get(POOL_ADDR);
    expect(pool?.protocol).toBe("UNKNOWN_V3");
  });
});

describe("Multiple events in sequence", () => {
  it("processes V2 and V3 pool creation in same block", async () => {
    const indexer = createTestIndexer();

    const result = await indexer.process({
      chains: {
        137: {
          simulate: [
            {
              contract: "V2Factory",
              event: "PairCreated",
              srcAddress: QUICKSWAP_V2,
              block: { number: SIM_BLOCK },
              params: { token0: WMATIC, token1: USDC, pair: PAIR_ADDR, _3: 1n },
            },
            {
              contract: "V3Factory",
              event: "PoolCreated",
              srcAddress: UNISWAP_V3,
              block: { number: SIM_BLOCK },
              params: { token0: WETH, token1: USDT, fee: 500n, tickSpacing: 10n, pool: POOL_ADDR },
            },
          ],
        },
      },
    });

    // Both pools should exist regardless of how changes are split across entries
    const v2pool = await indexer.PoolMeta.get(PAIR_ADDR);
    const v3pool = await indexer.PoolMeta.get(POOL_ADDR);
    expect(v2pool?.protocol).toBe("QUICKSWAP_V2");
    expect(v3pool?.protocol).toBe("UNISWAP_V3");

    // Total events across all change entries should be 2
    const totalEvents = result.changes.reduce((sum, c) => sum + c.eventsProcessed, 0);
    expect(totalEvents).toBeGreaterThanOrEqual(2);
  });
});

describe("UniswapV2Pool.Sync", () => {
  it("is a no-op (hot state fetched by arb bot RPC)", async () => {
    const indexer = createTestIndexer();

    await indexer.process({
      chains: {
        137: {
          simulate: [
            {
              contract: "V2Factory",
              event: "PairCreated",
              srcAddress: QUICKSWAP_V2,
              block: { number: SIM_BLOCK },
              params: {
                token0: WMATIC,
                token1: USDC,
                pair: PAIR_ADDR,
                _3: 1n,
              },
            },
            {
              contract: "UniswapV2Pool",
              event: "Sync",
              srcAddress: PAIR_ADDR,
              block: { number: SIM_BLOCK + 1 },
              params: {
                reserve0: 1000n,
                reserve1: 2000n,
              },
            },
          ],
        },
      },
    });

    const state = await indexer.V2PoolState.get(PAIR_ADDR);
    expect(state).toBeUndefined();
  });
});

describe("UniswapV3Pool.Initialize & Swap", () => {
  it("is a no-op (hot state fetched by arb bot RPC)", async () => {
    const indexer = createTestIndexer();

    await indexer.process({
      chains: {
        137: {
          simulate: [
            {
              contract: "V3Factory",
              event: "PoolCreated",
              srcAddress: UNISWAP_V3,
              block: { number: SIM_BLOCK },
              params: {
                token0: WETH,
                token1: USDC,
                fee: 500n,
                tickSpacing: 10n,
                pool: POOL_ADDR,
              },
            },
            {
              contract: "UniswapV3Pool",
              event: "Initialize",
              srcAddress: POOL_ADDR,
              block: { number: SIM_BLOCK + 1 },
              params: {
                sqrtPriceX96: 12345n,
                tick: 100n,
              },
            },
            {
              contract: "UniswapV3Pool",
              event: "Swap",
              srcAddress: POOL_ADDR,
              block: { number: SIM_BLOCK + 2 },
              params: {
                sender: POOL_ADDR,
                recipient: POOL_ADDR,
                amount0: -100n,
                amount1: 100n,
                sqrtPriceX96: 12346n,
                liquidity: 5000n,
                tick: 101n,
              },
            },
          ],
        },
      },
    });

    const state = await indexer.V3PoolState.get(POOL_ADDR);
    expect(state).toBeUndefined();
  });
});

describe("DodoPool.Sync", () => {
  it("is a no-op (preserves existing DodoPoolState from factory seed)", async () => {
    const indexer = createTestIndexer();
    const DODO_POOL = "0xdddddddddddddddddddddddddddddddddddddddd";

    // Seed the state database directly, bypassing DVMDeployed factory event and RPC fetches
    indexer.DodoPoolState.set({
      id: DODO_POOL,
      address: DODO_POOL,
      lastUpdatedBlock: SIM_BLOCK,
      baseReserve: 0n,
      quoteReserve: 0n,
      targetBase: 0n,
      targetQuote: 0n,
      rStatus: 0,
      k: 0n,
      fee: 0n,
      i: 0n,
      lpFeeRate: 0n,
      mtFeeRate: 0n,
    });

    await indexer.process({
      chains: {
        137: {
          simulate: [
            {
              contract: "DodoPool",
              event: "Sync",
              srcAddress: DODO_POOL,
              block: { number: SIM_BLOCK + 1 },
              params: {
                reserve0: 1000000000000000000n, // base
                reserve1: 1000000n, // quote
              },
            },
          ],
        },
      },
    });

    const state = await indexer.DodoPoolState.get(DODO_POOL);
    expect(state).toBeDefined();
    expect(state?.baseReserve).toBe(0n);
    expect(state?.quoteReserve).toBe(0n);
    expect(state?.lastUpdatedBlock).toBe(SIM_BLOCK);
  });
});
