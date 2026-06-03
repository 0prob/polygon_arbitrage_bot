/**
 * Shared numeric constants used across the bot.
 * Central place prevents drift between assessment math, calldata encoding, etc.
 */

export const BPS_DENOM = 10_000n; // For bigint-based profit/risk/slippage calculations
export const BPS_DENOMINATOR = 10_000; // For number-based slippage/fee encoding in calldata

// Re-export garbage functions from the single source of truth (infra/garbage/garbage-tracker.ts)
// This keeps core/ as convenient import point while ensuring no duplicated logic or lists.
export {
  isGarbageAddress,
  isGarbagePool,
  markAsGarbage,
  getAllGarbageAddresses,
  loadGarbageAddresses,
  performOneTimeGarbageCleanup,
  KNOWN_INDEXED_FACTORIES,
} from "../infra/garbage/garbage-tracker.ts";
