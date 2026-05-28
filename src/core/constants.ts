/**
 * Shared numeric constants used across the bot.
 * Central place prevents drift between assessment math, calldata encoding, etc.
 */

export const BPS_DENOM = 10_000n; // For bigint-based profit/risk/slippage calculations
export const BPS_DENOMINATOR = 10_000; // For number-based slippage/fee encoding in calldata
