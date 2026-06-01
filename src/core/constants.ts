/**
 * Shared numeric constants used across the bot.
 * Central place prevents drift between assessment math, calldata encoding, etc.
 */

export const BPS_DENOM = 10_000n; // For bigint-based profit/risk/slippage calculations
export const BPS_DENOMINATOR = 10_000; // For number-based slippage/fee encoding in calldata

import { isGarbagePool as isGarbagePoolTracker } from "../infra/garbage/garbage-tracker.ts";

/**
 * @deprecated Use `isGarbageAddress` from `src/infra/garbage/garbage-tracker.ts` instead.
 * The list is now persisted in `data/garbage-addresses.json` and can be updated automatically.
 */
export const KNOWN_GARBAGE_ADDRESSES = new Set<string>([
  "0x5757371414417b8c6caad45baef941abc7d3ab32", // Quickswap V2 factory (emitted itself as a token)
]);

/** Returns true if any token in the pool is a known garbage address. */
export function isGarbagePool(pool: { address: string; tokens?: string[] }): boolean {
  return isGarbagePoolTracker(pool);
}
