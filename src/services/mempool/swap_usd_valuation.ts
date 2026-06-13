import type { PriceOracle } from "../oracle/price_oracle.ts";
import type { DecodedSwap } from "./decoder.ts";

/** Fixed-point micro-dollars (1 USD = 1_000_000). */
export const USD_MICRO = 1_000_000n;
const RATE_PRECISION = 10n ** 18n;

export type SwapUsdValuationSource = "direct_usd" | "matic_rate" | "unknown";

export interface SwapUsdValuationResult {
  passes: boolean;
  usdMicro: bigint | null;
  source: SwapUsdValuationSource;
}

export interface SwapUsdValuationUpdate {
  maticUsd?: number;
  tokenToMaticRates?: ReadonlyMap<string, bigint>;
  tokenDecimals?: ReadonlyMap<string, number>;
  tokenUsd?: ReadonlyMap<string, number>;
  poolMetas?: ReadonlyArray<{ address: string; token0: string; token1: string }>;
}

/**
 * Converts pending-swap input amounts (raw token units) to USD for threshold checks.
 * Uses a sync snapshot updated by the LF/HF pass (pool-graph MATIC rates + oracle USD cache).
 */
export class SwapUsdValuator {
  private thresholdUsdMicro: bigint;
  private maticUsdMicro = 700_000n;
  private tokenToMaticRates = new Map<string, bigint>();
  private tokenDecimals = new Map<string, number>();
  private tokenUsdMicro = new Map<string, bigint>();
  private poolTokens = new Map<string, { token0: string; token1: string }>();

  constructor(thresholdUsd: number) {
    this.thresholdUsdMicro = BigInt(Math.max(0, Math.floor(thresholdUsd * Number(USD_MICRO))));
  }

  setThresholdUsd(thresholdUsd: number): void {
    this.thresholdUsdMicro = BigInt(Math.max(0, Math.floor(thresholdUsd * Number(USD_MICRO))));
  }

  update(snap: SwapUsdValuationUpdate): void {
    if (snap.maticUsd != null && snap.maticUsd > 0) {
      this.maticUsdMicro = BigInt(Math.round(snap.maticUsd * Number(USD_MICRO)));
    }
    if (snap.tokenToMaticRates) {
      this.tokenToMaticRates = new Map(snap.tokenToMaticRates);
    }
    if (snap.tokenDecimals) {
      this.tokenDecimals = new Map(snap.tokenDecimals);
    }
    if (snap.tokenUsd) {
      this.tokenUsdMicro = new Map(
        [...snap.tokenUsd.entries()].map(([token, usd]) => [token.toLowerCase(), BigInt(Math.round(usd * Number(USD_MICRO)))]),
      );
    }
    if (snap.poolMetas) {
      this.poolTokens = new Map(
        snap.poolMetas.map((p) => [
          p.address.toLowerCase(),
          { token0: p.token0.toLowerCase(), token1: p.token1.toLowerCase() },
        ]),
      );
    }
  }

  getPoolTokens(): ReadonlyMap<string, { token0: string; token1: string }> {
    return this.poolTokens;
  }

  /** Pull fresh Chainlink/Pyth USD quotes already cached by the oracle (sync, hot-path safe). */
  ingestOracleCache(oracle: PriceOracle): void {
    for (const [token, usd] of oracle.exportCachedTokenUsd()) {
      if (usd > 0) this.tokenUsdMicro.set(token, BigInt(Math.round(usd * Number(USD_MICRO))));
    }
    const maticUsd = oracle.getCachedMaticUsd();
    if (maticUsd != null && maticUsd > 0) {
      this.maticUsdMicro = BigInt(Math.round(maticUsd * Number(USD_MICRO)));
    }
  }

  evaluate(tokenIn: string, amountRaw: bigint): SwapUsdValuationResult {
    if (amountRaw <= 0n) {
      return { passes: false, usdMicro: 0n, source: "unknown" };
    }

    const usd = estimateRawAmountUsdMicro(tokenIn, amountRaw, {
      maticUsdMicro: this.maticUsdMicro,
      tokenToMaticRates: this.tokenToMaticRates,
      tokenDecimals: this.tokenDecimals,
      tokenUsdMicro: this.tokenUsdMicro,
    });

    if (usd.value == null) {
      // Unknown valuation — do not suppress; avoids missing large swaps on exotic tokens.
      return { passes: true, usdMicro: null, source: "unknown" };
    }

    return {
      passes: usd.value >= this.thresholdUsdMicro,
      usdMicro: usd.value,
      source: usd.source,
    };
  }
}

/** Keep mempool USD threshold in sync with LF/HF rate snapshots (sync, hot-path safe). */
export function refreshSwapUsdValuator(
  valuator: SwapUsdValuator,
  snap: {
    maticPriceUsd: number;
    tokenToMaticRates: ReadonlyMap<string, bigint>;
    cachedMetas: ReadonlyMap<string, { decimals: number }> | null;
    hasuraPoolsCache?: ReadonlyArray<{ address: string; token0: string; token1: string }> | null;
  },
  priceOracle?: PriceOracle,
): void {
  const tokenDecimals = snap.cachedMetas
    ? new Map([...snap.cachedMetas.entries()].map(([k, v]) => [k.toLowerCase(), v.decimals]))
    : undefined;
  valuator.update({
    maticUsd: snap.maticPriceUsd,
    tokenToMaticRates: snap.tokenToMaticRates,
    tokenDecimals,
    poolMetas: snap.hasuraPoolsCache ?? undefined,
  });
  if (priceOracle) valuator.ingestOracleCache(priceOracle);
}

/** Resolve input token for USD threshold when decoder leaves tokenIn empty (common on direct pool.swap). */
export function resolveMempoolInputToken(
  decoded: Pick<DecodedSwap, "tokenIn" | "poolAddress" | "zeroForOne">,
  poolTokens: ReadonlyMap<string, { token0: string; token1: string }>,
): string {
  if (decoded.tokenIn && decoded.tokenIn.length === 42 && decoded.tokenIn.startsWith("0x")) {
    return decoded.tokenIn.toLowerCase();
  }
  const meta = poolTokens.get(decoded.poolAddress.toLowerCase());
  if (!meta) return "";
  return (decoded.zeroForOne === false ? meta.token1 : meta.token0).toLowerCase();
}

export function estimateRawAmountUsdMicro(
  tokenIn: string,
  amountRaw: bigint,
  snap: {
    maticUsdMicro: bigint;
    tokenToMaticRates: ReadonlyMap<string, bigint>;
    tokenDecimals: ReadonlyMap<string, number>;
    tokenUsdMicro: ReadonlyMap<string, bigint>;
  },
): { value: bigint | null; source: SwapUsdValuationSource } {
  const token = tokenIn.toLowerCase();

  const directUsdPerToken = snap.tokenUsdMicro.get(token);
  if (directUsdPerToken != null && directUsdPerToken > 0n) {
    const decimals = snap.tokenDecimals.get(token) ?? 18;
    const scale = 10n ** BigInt(decimals);
    if (scale > 0n) {
      return { value: (amountRaw * directUsdPerToken) / scale, source: "direct_usd" };
    }
  }

  const maticRate = snap.tokenToMaticRates.get(token);
  if (maticRate != null && maticRate > 0n && snap.maticUsdMicro > 0n) {
    const maticWei = (amountRaw * maticRate) / RATE_PRECISION;
    return { value: (maticWei * snap.maticUsdMicro) / RATE_PRECISION, source: "matic_rate" };
  }

  return { value: null, source: "unknown" };
}
