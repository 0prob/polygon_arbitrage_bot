import { describe, it, expect } from "vitest";
import { SwapUsdValuator, estimateRawAmountUsdMicro, resolveMempoolInputToken, USD_MICRO } from "./swap_usd_valuation.ts";
import type { DecodedSwap } from "./decoder.ts";

const USDC = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";
const WMATIC = "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270";

describe("estimateRawAmountUsdMicro", () => {
  it("values USDC via direct USD feed with 6 decimals", () => {
    const tenThousandUsdc = 10_000n * 10n ** 6n;
    const { value, source } = estimateRawAmountUsdMicro(USDC, tenThousandUsdc, {
      maticUsdMicro: 700_000n,
      tokenToMaticRates: new Map(),
      tokenDecimals: new Map([[USDC, 6]]),
      tokenUsdMicro: new Map([[USDC, USD_MICRO]]),
    });

    expect(source).toBe("direct_usd");
    expect(value).toBe(10_000n * USD_MICRO);
  });

  it("values WMATIC via pool-graph MATIC rate", () => {
    const amount = 20_000n * 10n ** 18n;
    const { value, source } = estimateRawAmountUsdMicro(WMATIC, amount, {
      maticUsdMicro: 500_000n,
      tokenToMaticRates: new Map([[WMATIC, 10n ** 18n]]),
      tokenDecimals: new Map([[WMATIC, 18]]),
      tokenUsdMicro: new Map(),
    });

    expect(source).toBe("matic_rate");
    expect(value).toBe(10_000n * USD_MICRO);
  });
});

describe("SwapUsdValuator", () => {
  it("passes large USDC swaps and rejects small ones", () => {
    const valuator = new SwapUsdValuator(10_000);
    valuator.update({
      tokenDecimals: new Map([[USDC, 6]]),
      tokenUsd: new Map([[USDC, 1]]),
    });

    const large = valuator.evaluate(USDC, 15_000n * 10n ** 6n);
    expect(large.passes).toBe(true);
    expect(large.usdMicro).toBe(15_000n * USD_MICRO);

    const small = valuator.evaluate(USDC, 500n * 10n ** 6n);
    expect(small.passes).toBe(false);
    expect(small.usdMicro).toBe(500n * USD_MICRO);
  });

  it("allows unknown tokens through instead of mis-filtering", () => {
    const valuator = new SwapUsdValuator(10_000);
    const exotic = valuator.evaluate("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef", 1n);
    expect(exotic.passes).toBe(true);
    expect(exotic.source).toBe("unknown");
    expect(exotic.usdMicro).toBeNull();
  });
});

describe("resolveMempoolInputToken", () => {
  const pool = "0x" + "a".repeat(40);
  const token0 = USDC;
  const token1 = WMATIC;
  const pools = new Map([[pool, { token0, token1 }]]);

  it("uses zeroForOne to pick token0 vs token1", () => {
    const zfo: Pick<DecodedSwap, "tokenIn" | "poolAddress" | "zeroForOne"> = {
      tokenIn: "" as any,
      poolAddress: pool as any,
      zeroForOne: true,
    };
    expect(resolveMempoolInputToken(zfo, pools)).toBe(token0);

    const zfi = { ...zfo, zeroForOne: false };
    expect(resolveMempoolInputToken(zfi, pools)).toBe(token1);
  });
});
