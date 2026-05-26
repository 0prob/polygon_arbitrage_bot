import { describe, it, expect } from "vitest";
import { simulateHop, simulateRoute, getEffectivePriceImpact } from "./simulator.ts";
import type { SimulationEdge } from "./simulator.ts";
import type { SwapEdge } from "./graph.ts";
import type { Address } from "../../core/types/common.ts";
import { TokenRegistry } from "./token_registry.ts";

describe("simulateHop", () => {
  it("dispatches V2 swap correctly", () => {
    const edge: SimulationEdge = {
      poolAddress: "0xpool",
      tokenIn: "0xa",
      tokenOut: "0xb",
      protocol: "UNISWAP_V2",
      zeroForOne: true,
      stateRef: { reserve0: 10000n, reserve1: 20000n },
    };
    const result = simulateHop(edge, 1000n, new Map());
    expect(result.amountOut).toBeGreaterThan(0n);
    expect(result.gasEstimate).toBeGreaterThan(0);
  });

  it("dispatches V3 swap correctly", () => {
    const edge: SimulationEdge = {
      poolAddress: "0xpool",
      tokenIn: "0xa",
      tokenOut: "0xb",
      protocol: "UNISWAP_V3",
      zeroForOne: true,
      stateRef: {
        sqrtPriceX96: 2n ** 96n,
        tick: 0,
        liquidity: 100000n,
        fee: 3000n,
        initialized: true,
      },
    };
    const result = simulateHop(edge, 1000n, new Map());
    expect(result.amountOut).toBeGreaterThan(0n);
  });

  it("dispatches Curve swap correctly", () => {
    const edge: SimulationEdge = {
      poolAddress: "0xpool",
      tokenIn: "0xa",
      tokenOut: "0xb",
      protocol: "CURVE_STABLE",
      zeroForOne: true,
      tokenInIdx: 0,
      tokenOutIdx: 1,
      stateRef: {
        balances: [1000000n, 1000000n],
        rates: [10n ** 18n, 10n ** 18n],
        fee: 4000000n,
        A: 100n,
      },
    };
    const result = simulateHop(edge, 1000n, new Map());
    expect(result.amountOut).toBeGreaterThan(0n);
  });

  it("dispatches Balancer swap correctly", () => {
    const edge: SimulationEdge = {
      poolAddress: "0xpool",
      tokenIn: "0xa",
      tokenOut: "0xb",
      protocol: "BALANCER_V2",
      zeroForOne: true,
      tokenInIdx: 0,
      tokenOutIdx: 1,
      stateRef: {
        balances: [1000000000000000000000n, 2000000000000000000000n],
        weights: [500000000000000000n, 500000000000000000n],
        swapFee: 3000000000000000n,
      },
    };
    const result = simulateHop(edge, 1000000000000000000n, new Map());
    expect(result.amountOut).toBeGreaterThan(0n);
  });

  it("dispatches Dodo swap correctly", () => {
    const edge: SimulationEdge = {
      poolAddress: "0xpool",
      tokenIn: "0xa",
      tokenOut: "0xb",
      protocol: "DODO_V2",
      zeroForOne: true,
      stateRef: {
        i: 10n ** 18n,
        k: 0n,
        baseReserve: 1000000n,
        quoteReserve: 2000000n,
        baseTarget: 1000000n,
        quoteTarget: 2000000n,
        rState: 0,
        lpFeeRate: 0n,
        mtFeeRate: 0n,
      },
    };
    const result = simulateHop(edge, 1000n, new Map());
    expect(result.amountOut).toBeGreaterThan(0n);
  });

  it("dispatches Woofi swap correctly", () => {
    const edge: SimulationEdge = {
      poolAddress: "0xpool",
      tokenIn: "0xa",
      tokenOut: "0xb",
      protocol: "WOOFI",
      zeroForOne: true,
      tokenInIdx: 0,
      tokenOutIdx: 1,
      stateRef: {
        quoteReserve: 1000000000000000000000n,
        tokens: ["0xa", "0xb"],
        baseTokenStates: {
          "0xb": {
            price: 10n ** 18n,
            coeff: 0n,
            spread: 0n,
            feeRate: 100n,
            feasible: true,
            woFeasible: true,
            baseDec: 10n ** 18n,
            quoteDec: 10n ** 6n,
            priceDec: 10n ** 18n,
            reserve: 1000000000000000000000n,
          },
          "0xa": {
            price: 10n ** 18n,
            coeff: 0n,
            spread: 0n,
            feeRate: 100n,
            feasible: true,
            woFeasible: true,
            baseDec: 10n ** 18n,
            quoteDec: 10n ** 6n,
            priceDec: 10n ** 18n,
            reserve: 1000000000000000000000n,
          },
        },
      },
    };
    const result = simulateHop(edge, 1000n, new Map());
    expect(result.amountOut).toBeGreaterThan(0n);
  });

  it("throws for unknown protocol", () => {
    const edge: SimulationEdge = {
      poolAddress: "0xpool",
      tokenIn: "0xa",
      tokenOut: "0xb",
      protocol: "MYSTERY_PROTOCOL",
      zeroForOne: true,
      stateRef: {},
    };
    expect(() => simulateHop(edge, 1000n, new Map())).toThrow("MYSTERY_PROTOCOL");
  });

  it("throws for missing state", () => {
    const edge: SimulationEdge = {
      poolAddress: "0xpool",
      tokenIn: "0xa",
      tokenOut: "0xb",
      protocol: "UNISWAP_V2",
      zeroForOne: true,
    };
    expect(() => simulateHop(edge, 1000n, new Map())).toThrow("No valid state");
  });

  it("falls back to stateCache when stateRef is not on edge", () => {
    const cache = new Map();
    cache.set("0xpool", { reserve0: 10000n, reserve1: 20000n });
    const edge: SimulationEdge = {
      poolAddress: "0xpool",
      tokenIn: "0xa",
      tokenOut: "0xb",
      protocol: "UNISWAP_V2",
      zeroForOne: true,
    };
    const result = simulateHop(edge, 1000n, cache);
    expect(result.amountOut).toBeGreaterThan(0n);
  });

  it("applies sell tax correctly", () => {
    const registry = new TokenRegistry({
      "0xa": { buyTaxMultiplier: 1.0, sellTaxMultiplier: 0.9 },
    });
    const edge: SimulationEdge = {
      poolAddress: "0xpool",
      tokenIn: "0xa",
      tokenOut: "0xb",
      protocol: "UNISWAP_V2",
      zeroForOne: true,
      stateRef: { reserve0: 100000n, reserve1: 100000n },
    };
    // Without tax, 1000 in -> 100000 - (100000 * 100000 / (100000 + 1000)) = 100000 - 99009 = 991 (approx)
    // With 10% sell tax, effective in = 900
    // 900 in -> 100000 - (100000 * 100000 / (100000 + 900)) = 100000 - 99108 = 892 (approx)

    // Test without registry
    const resNoTax = simulateHop(edge, 1000n, new Map());
    // Test with registry
    const resWithTax = simulateHop(edge, 1000n, new Map(), registry);

    expect(resWithTax.amountOut).toBeLessThan(resNoTax.amountOut);
  });

  it("applies buy tax correctly", () => {
    const registry = new TokenRegistry({
      "0xb": { buyTaxMultiplier: 0.9, sellTaxMultiplier: 1.0 },
    });
    const edge: SimulationEdge = {
      poolAddress: "0xpool",
      tokenIn: "0xa",
      tokenOut: "0xb",
      protocol: "UNISWAP_V2",
      zeroForOne: true,
      stateRef: { reserve0: 100000n, reserve1: 100000n },
    };

    // Test without registry
    const resNoTax = simulateHop(edge, 1000n, new Map());
    // Test with registry
    const resWithTax = simulateHop(edge, 1000n, new Map(), registry);

    expect(resWithTax.amountOut).toBeLessThan(resNoTax.amountOut);
  });
});

describe("simulateRoute", () => {
  it("computes a 2-hop route", () => {
    const WETH = "0xa" as Address;
    const USDC = "0xb" as Address;
    const poolA = "0xpoolA" as Address;
    const poolB = "0xpoolB" as Address;

    const edges: SwapEdge[] = [
      {
        poolAddress: poolA,
        protocol: "UNISWAP_V2",
        tokenIn: WETH,
        tokenOut: USDC,
        feeBps: 30n,
        zeroForOne: true,
        tokenInIdx: 0,
        tokenOutIdx: 1,
        stateRef: { reserve0: 10000n, reserve1: 20000n, token0: WETH, token1: USDC },
      },
      {
        poolAddress: poolB,
        protocol: "UNISWAP_V2",
        tokenIn: USDC,
        tokenOut: WETH,
        feeBps: 30n,
        zeroForOne: true,
        tokenInIdx: 0,
        tokenOutIdx: 1,
        stateRef: { reserve0: 20000n, reserve1: 10000n, token0: USDC, token1: WETH },
      },
    ];

    const result = simulateRoute(edges, 1000n, new Map());
    expect(result.amountOut).toBeGreaterThan(0n);
    expect(result.amountOut).not.toBe(result.amountIn);
    expect(result.hopCount).toBe(2);
    expect(result.hopAmounts.length).toBe(3);
    expect(result.poolPath).toEqual([poolA, poolB]);
    expect(result.protocols).toEqual(["UNISWAP_V2", "UNISWAP_V2"]);
  });

  it("marks route as profitable when amountOut > amountIn", () => {
    const A = "0xa" as Address;
    const B = "0xb" as Address;
    const p1 = "0xp1" as Address;
    const p2 = "0xp2" as Address;
    const edges: SwapEdge[] = [
      {
        poolAddress: p1,
        protocol: "UNISWAP_V2",
        tokenIn: A,
        tokenOut: B,
        feeBps: 30n,
        zeroForOne: true,
        tokenInIdx: 0,
        tokenOutIdx: 1,
        stateRef: { reserve0: 1000000n, reserve1: 1000000n, token0: A, token1: B },
      },
      {
        poolAddress: p2,
        protocol: "UNISWAP_V2",
        tokenIn: B,
        tokenOut: A,
        feeBps: 30n,
        zeroForOne: true,
        tokenInIdx: 0,
        tokenOutIdx: 1,
        stateRef: { reserve0: 1000000n, reserve1: 1000000n, token0: B, token1: A },
      },
    ];
    const result = simulateRoute(edges, 1000n, new Map());
    expect(result.profitable).toBe(result.profit > 0n);
  });

  it("throws when state is missing for a hop", () => {
    const edges: SwapEdge[] = [
      {
        poolAddress: "0xpool" as Address,
        protocol: "UNISWAP_V2",
        tokenIn: "0xa" as Address,
        tokenOut: "0xb" as Address,
        feeBps: 30n,
        zeroForOne: true,
        tokenInIdx: 0,
        tokenOutIdx: 1,
      },
    ];
    expect(() => simulateRoute(edges, 1000n, new Map())).toThrow("No valid state");
  });
});

describe("getEffectivePriceImpact", () => {
  it("calculates correct impact for a V2 pool (1:1)", () => {
    const edge: SwapEdge = {
      poolAddress: "0xpool" as Address,
      protocol: "UNISWAP_V2",
      tokenIn: "0xa" as Address,
      tokenOut: "0xb" as Address,
      feeBps: 30n,
      zeroForOne: true,
      tokenInIdx: 0,
      tokenOutIdx: 1,
      stateRef: { reserve0: 1000000n, reserve1: 1000000n, token0: "0xa", token1: "0xb" },
    };

    // amountIn = 10000n, pool reserves = 1,000,000. Impact should be roughly 1%
    const impact = getEffectivePriceImpact(edge, 10000n, new Map());
    expect(impact).toBeGreaterThan(0);
    expect(impact).toBeLessThan(0.02);
  });

  it("calculates correct impact for a V2 pool (1:2)", () => {
    const edge: SwapEdge = {
      poolAddress: "0xpool" as Address,
      protocol: "UNISWAP_V2",
      tokenIn: "0xa" as Address,
      tokenOut: "0xb" as Address,
      feeBps: 30n,
      zeroForOne: true,
      tokenInIdx: 0,
      tokenOutIdx: 1,
      stateRef: { reserve0: 100000000n, reserve1: 200000000n, token0: "0xa", token1: "0xb" },
    };

    // Spot price is 2.0. small amountIn should have impact near 0.3% (fee)
    const impact = getEffectivePriceImpact(edge, 1000n, new Map());
    expect(impact).toBeGreaterThan(0.002);
    expect(impact).toBeLessThan(0.005);
  });

  it("calculates correct impact for a V3 pool (non-1:1)", () => {
    const edge: SwapEdge = {
      poolAddress: "0xpool" as Address,
      protocol: "UNISWAP_V3",
      tokenIn: "0xa" as Address,
      tokenOut: "0xb" as Address,
      feeBps: 3000n,
      zeroForOne: true,
      tokenInIdx: 0,
      tokenOutIdx: 1,
      stateRef: {
        sqrtPriceX96: 112045541949572279837463876454n, // sqrt(2)
        tick: 6931,
        liquidity: 1000000000000000n,
        fee: 3000n,
        initialized: true,
      },
    };

    // Spot price is 2.0. small amountIn should have impact near 0.3% (fee)
    const impact = getEffectivePriceImpact(edge, 10000n, new Map());
    expect(impact).toBeGreaterThan(0.002);
    expect(impact).toBeLessThan(0.005);
  });

  it("returns 0 impact for 0 amount", () => {
    const edge: SwapEdge = {
      poolAddress: "0xpool" as Address,
      protocol: "UNISWAP_V2",
      tokenIn: "0xa" as Address,
      tokenOut: "0xb" as Address,
      feeBps: 30n,
      zeroForOne: true,
      tokenInIdx: 0,
      tokenOutIdx: 1,
      stateRef: { reserve0: 1000000n, reserve1: 1000000n, token0: "0xa", token1: "0xb" },
    };
    const impact = getEffectivePriceImpact(edge, 0n, new Map());
    expect(impact).toBe(0);
  });
});
