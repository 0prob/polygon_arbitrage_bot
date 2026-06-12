import { describe, it, expect } from "vitest";
import { normalizeProtocol, feeToBps } from "./protocol.ts";

describe("normalizeProtocol", () => {
  it("maps protocol families", () => {
    expect(normalizeProtocol("QUICKSWAP_V2")).toBe("V2");
    expect(normalizeProtocol("UNISWAP_V3")).toBe("V3");
    expect(normalizeProtocol("UNISWAP_V4")).toBe("V4");
    expect(normalizeProtocol("KYBERSWAP_ELASTIC")).toBe("V3");
    expect(normalizeProtocol("BALANCER_V2")).toBe("BALANCER");
    expect(normalizeProtocol("CURVE_STABLE")).toBe("CURVE");
    expect(normalizeProtocol("DODO_V2")).toBe("DODO");
    expect(normalizeProtocol("WOOFI")).toBe("WOOFI");
  });
});

describe("feeToBps", () => {
  it("keeps V2-family / Balancer / DODO fees as bps", () => {
    expect(feeToBps("QUICKSWAP_V2", 30n)).toBe(30n);
    expect(feeToBps("SUSHISWAP_V2", 25n)).toBe(25n);
    expect(feeToBps("APESWAP_V2", 20n)).toBe(20n);
    expect(feeToBps("BALANCER_V2", 30n)).toBe(30n);
    expect(feeToBps("DODO_V2", 10n)).toBe(10n);
  });

  it("converts V3/V4 pips (1e6 = 100%) to bps", () => {
    expect(feeToBps("UNISWAP_V3", 3000n)).toBe(30n); // 0.30%
    expect(feeToBps("UNISWAP_V3", 500n)).toBe(5n); // 0.05%
    expect(feeToBps("UNISWAP_V3", 10000n)).toBe(100n); // 1.00%
    expect(feeToBps("UNISWAP_V4", 3000n)).toBe(30n);
    expect(feeToBps("QUICKSWAP_V3", 100n)).toBe(1n); // 0.01%
  });

  it("converts Kyber Elastic / WooFi fee-units (1e5 = 100%) to bps", () => {
    expect(feeToBps("KYBERSWAP_ELASTIC", 300n)).toBe(30n); // 0.30%
    expect(feeToBps("KYBERSWAP_ELASTIC", 8n)).toBe(0n); // 0.008% rounds below 1 bps
    expect(feeToBps("WOOFI", 25n)).toBe(2n); // 0.025%
  });
});
