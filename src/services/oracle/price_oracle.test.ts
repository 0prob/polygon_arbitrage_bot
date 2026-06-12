import { describe, it, expect, vi, beforeEach } from "vitest";
import { PriceOracle, enrichTokenToMaticRates } from "./price_oracle.ts";

describe("PriceOracle", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("uses pool-graph rate when oracle disabled", async () => {
    const oracle = new PriceOracle({ enabled: false });
    const poolRate = 2_000_000_000_000_000_000n;
    const { rate, source } = await oracle.getTokenToMaticRate(
      "0x2791bca1f2de4661ed88a30c99a7a9449aa84174",
      poolRate,
    );
    expect(rate).toBe(poolRate);
    expect(source).toBe("pool");
  });

  it("blocks token when pool-graph and oracle diverge beyond threshold", async () => {
    const mockClient = {
      readContract: vi.fn().mockImplementation(({ functionName }: { functionName: string }) => {
        if (functionName === "latestRoundData") return Promise.resolve([0n, 1_000_000_000n, 0n, 0n, 0n]);
        if (functionName === "decimals") return Promise.resolve(8);
        return Promise.resolve(0n);
      }),
    };

    const oracle = new PriceOracle({ enabled: true, maxDivergenceBps: 100, client: mockClient as any });
    vi.spyOn(oracle as any, "fetchPythPrice").mockResolvedValue(null);

    const poolRate = 1n;
    const { rate, source } = await oracle.getTokenToMaticRate(
      "0x2791bca1f2de4661ed88a30c99a7a9449aa84174",
      poolRate,
      mockClient as any,
    );
    expect(source).toBe("blocked");
    expect(rate).toBe(0n);
  });

  it("enrichTokenToMaticRates removes blocked tokens", async () => {
    const oracle = new PriceOracle({ enabled: false });
    vi.spyOn(oracle, "getTokenToMaticRate").mockResolvedValue({ rate: 0n, source: "blocked" });

    const rates = new Map([["0xabc", 100n]]);
    const out = await enrichTokenToMaticRates(oracle, rates, ["0xabc"]);
    expect(out.has("0xabc")).toBe(false);
  });
});
