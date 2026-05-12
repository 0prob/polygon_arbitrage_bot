/**
 * src/execution/gas_adjustment.ts — Gas estimation feedback loop
 *
 * Compares simulated gas estimates with actual gas used on-chain,
 * and adjusts future estimates via a multiplier.
 */

import { CONFIG_GAS_ADJUSTMENT_ALPHA } from "../config/index.ts";

let gasEstimateMultiplier = 1.0;

/**
 * Update the gas estimation multiplier based on actual vs estimated gas.
 * Uses exponential moving average (configurable alpha) and clamps to [0.5, 2.0].
 */
export function updateGasEstimateMultiplier(actualGas: number, estimatedGas: number): void {
  if (estimatedGas <= 0 || !Number.isFinite(estimatedGas)) return;
  if (actualGas < 0 || !Number.isFinite(actualGas)) return;
  const ratio = actualGas / estimatedGas;
  if (!Number.isFinite(ratio)) return;
  if (ratio < 0.2 || ratio > 5) return;
  const alpha = CONFIG_GAS_ADJUSTMENT_ALPHA;
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) return;
  const newMultiplier = gasEstimateMultiplier * (1 - alpha) + ratio * alpha;
  if (!Number.isFinite(newMultiplier)) return;
  gasEstimateMultiplier = newMultiplier;
  if (gasEstimateMultiplier < 0.5) gasEstimateMultiplier = 0.5;
  if (gasEstimateMultiplier > 2.0) gasEstimateMultiplier = 2.0;
}

/**
 * Get the current gas estimation multiplier.
 * Defaults to 1.0 (no adjustment).
 */
export function getGasEstimateMultiplier(): number {
  return gasEstimateMultiplier;
}

/**
 * Reset the multiplier to default (1.0). Useful for testing.
 */
export function resetGasEstimateMultiplier(): void {
  gasEstimateMultiplier = 1.0;
}
