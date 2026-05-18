import { mulDiv } from "../math/full_math.ts";
import type { Address } from "../types/common.ts";

/** A price quote: how much of `quoteToken` you get for 1 unit of `baseToken`. */
export interface PriceQuote {
  baseToken: Address;
  quoteToken: Address;
  /** Number of quote-token smallest units per 1 base-token smallest unit, scaled by 1e18. */
  rateScaled: bigint;
  /** Source label for diagnostics */
  source: string;
  /** Timestamp the quote was observed */
  timestampMs: number;
}

export const PIVOT_SCALE = 10n ** 18n;

/** Chain two quotes: A->B and B->C => A->C. Result is scaled by 1e18. */
export function composeQuotes(ab: PriceQuote, bc: PriceQuote): PriceQuote | null {
  if (ab.quoteToken !== bc.baseToken) return null;
  if (ab.rateScaled <= 0n || bc.rateScaled <= 0n) return null;
  const composed = mulDiv(ab.rateScaled, bc.rateScaled, PIVOT_SCALE);
  return {
    baseToken: ab.baseToken,
    quoteToken: bc.quoteToken,
    rateScaled: composed,
    source: `pivot:${ab.source}+${bc.source}`,
    timestampMs: Math.min(ab.timestampMs, bc.timestampMs),
  };
}

/** Convert a scaled rate to a different decimal context. */
export function rescaleRate(rateScaled: bigint, fromDecimals: number, toDecimals: number): bigint {
  if (fromDecimals === toDecimals) return rateScaled;
  if (fromDecimals < toDecimals) {
    const factor = 10n ** BigInt(toDecimals - fromDecimals);
    return rateScaled * factor;
  } else {
    const factor = 10n ** BigInt(fromDecimals - toDecimals);
    return rateScaled / factor;
  }
}
