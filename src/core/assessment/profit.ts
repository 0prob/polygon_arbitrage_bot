import { divRoundingUp } from "../math/full_math.ts";
import { bigintToApproxNumber } from "../utils/bigint.ts";
import { revertPenalty, slippageDeduction, flashLoanFee } from "./risk.ts";
import { FlashLoanSource } from "../types/execution.ts";
import type { ProfitAssessment } from "../types/execution.ts";

/**
 * Profit & risk assessment for flash-loan-only arbitrage.
 * The bot has no capital-backed execution mode. Every profitable cycle is funded 100%
 * by a flash loan (Balancer or Aave). The `amountIn` passed here is the flash principal,
 * and `flashLoanFee` is *always* subtracted before gas-adjusted profitability is decided.
 */

/**
 * Convert a token-denominated amount to MATIC wei using an oracle rate.
 *
 * `tokenToMaticRate` is the number of MATIC wei equivalent to 1 unit (smallest denomination)
 * of the token, SCALED by 1e18.
 */
export function tokensToMaticWei(amountInTokens: bigint, tokenToMaticRate: bigint): bigint {
  if (amountInTokens <= 0n) return 0n;
  if (tokenToMaticRate <= 0n) throw new Error("tokenToMaticRate must be > 0");
  return (amountInTokens * tokenToMaticRate) / 1000000000000000000n;
}

/**
 * Convert MATIC wei to token units using an oracle rate, rounding up (conservative).
 * `tokenToMaticRate` is SCALED by 1e18.
 */
export function maticWeiToTokens(amountInMaticWei: bigint, tokenToMaticRate: bigint): bigint {
  if (amountInMaticWei <= 0n) return 0n;
  if (tokenToMaticRate <= 0n) throw new Error("tokenToMaticRate must be > 0");
  return divRoundingUp(amountInMaticWei * 1000000000000000000n, tokenToMaticRate);
}

/** Compute gas cost in MATIC wei from gas units and gas price. */
export function gasCostMaticWei(gasUnits: number, gasPriceWei: bigint): bigint {
  if (!Number.isSafeInteger(gasUnits) || gasUnits < 0) throw new Error("gasUnits must be a finite non-negative safe integer");
  if (gasPriceWei < 0n) throw new Error("gasPriceWei must be >= 0");
  return BigInt(gasUnits) * gasPriceWei;
}

/** ROI in micro-units (parts per million) of profit / amountIn. */
export function roiMicroUnits(profit: bigint, amountIn: bigint): number {
  if (amountIn <= 0n) return 0;
  return bigintToApproxNumber((profit * 1_000_000n) / amountIn);
}

/**
 * Options for profit computation. All financial values are in source-defined units;
 * conversions to MATIC wei happen internally via tokenToMaticRate.
 */
export interface ComputeProfitOptions {
  /** Gross profit in start-token units (amountOut - amountIn) */
  grossProfitInTokens: bigint;
  /** Input amount in start-token units */
  amountInTokens: bigint;
  /** Gas units estimated for the route */
  gasUnits: number;
  /** Current gas price in wei (MATIC) */
  gasPriceWei: bigint;
  /** Rate: 1 token unit = N MATIC wei. Must be > 0. */
  tokenToMaticRate: bigint;
  /** Hop count for revert risk calculation */
  hopCount: number;
  /** Minimum acceptable net profit, in MATIC wei */
  minProfitMaticWei: bigint;
  /** Slippage in basis points (applied to gross profit) */
  slippageBps?: bigint;
  /** Base revert risk in basis points */
  revertRiskBps?: bigint;
  /** Flash loan source for fee calculation (required). Architecture is strictly flash-loan-only for all arbitrage; amountIn == flash principal borrowed. */
  flashLoanSource: FlashLoanSource;
  /** Override flash loan fee bps */
  flashLoanFeeBps?: bigint;
  /** Max ROI multiplier before rejection (defends against poisoned data) */
  roiSafetyCap?: number;
}

/**
 * Compute profit assessment with CORRECT unit handling.
 *
 * The previous implementation (src/arb/profit_compute.ts) compared `gasCost` in MATIC wei
 * against `minNetProfit` in start-token units, producing wrong accept/reject decisions
 * whenever the start token had a different price than MATIC.
 *
 * This implementation converts everything to MATIC wei (the canonical chain unit)
 * before any comparison. Returns assessment with both MATIC-wei and token-unit values
 * for diagnostic purposes.
 */
export function computeProfit(opts: ComputeProfitOptions): ProfitAssessment {
  const core = computeProfitCore(opts);

  const {
    grossProfitInTokens,
    amountInTokens: _amountInTokensUnusedInPublicWrapper,
    minProfitMaticWei,
    roiSafetyCap = 10.0,
  } = opts;

  const { netProfitInTokens, gasCostWei, netProfitAfterGasMaticWei, gasCostInTokens, netProfitAfterGasInTokens, roi, flashFee, slippage, revert } = core;

  let shouldExecute = netProfitAfterGasMaticWei >= minProfitMaticWei;
  let rejectReason: string | undefined;

  if (roi > (roiSafetyCap * 1_000_000)) {
    shouldExecute = false;
    rejectReason = `ROI outlier detected: ${roi / 1_000_000}x exceeds safety cap (${roiSafetyCap}x)`;
  }

  const result: ProfitAssessment = {
    shouldExecute,
    grossProfit: grossProfitInTokens,
    gasCostWei,
    gasCostInTokens,
    flashLoanFee: flashFee,
    slippageDeduction: slippage,
    revertPenalty: revert,
    netProfit: netProfitInTokens,
    netProfitAfterGas: netProfitAfterGasInTokens,
    netProfitAfterGasMaticWei: netProfitAfterGasMaticWei,
    roi,
    rejectReason,
  };

  if (!shouldExecute && !rejectReason) {
    if (netProfitAfterGasMaticWei < 0n) {
      result.rejectReason = `unprofitable after gas: ${netProfitAfterGasMaticWei} wei`;
    } else {
      result.rejectReason = `below minProfit: ${netProfitAfterGasMaticWei} < ${minProfitMaticWei}`;
    }
  }

  return result;
}

/**
 * Numeric-only core of profit calculation.
 * Used by hot-path ternary search probes to avoid allocating a full ProfitAssessment
 * on every single evaluation (major allocation win during amount optimization).
 */
export interface ProfitCoreNumbers {
  netProfitInTokens: bigint;
  gasCostWei: bigint;
  netProfitMaticWei: bigint;
  netProfitAfterGasMaticWei: bigint;
  gasCostInTokens: bigint;
  netProfitAfterGasInTokens: bigint;
  roi: number;
  flashFee: bigint;
  slippage: bigint;
  revert: bigint;
}

export function computeProfitCore(opts: ComputeProfitOptions): ProfitCoreNumbers {
  const {
    grossProfitInTokens,
    amountInTokens: _amountInTokens, // only needed for flash fee in full path
    gasUnits,
    gasPriceWei,
    tokenToMaticRate,
    hopCount,
    slippageBps = 50n,
    revertRiskBps: baseRiskBps = 500n,
    flashLoanSource,
    flashLoanFeeBps,
  } = opts;

  if (tokenToMaticRate <= 0n) {
    // Return zeros for search safety (search will treat this as unprofitable)
    return {
      netProfitInTokens: 0n,
      gasCostWei: 0n,
      netProfitMaticWei: 0n,
      netProfitAfterGasMaticWei: -1n,
      gasCostInTokens: 0n,
      netProfitAfterGasInTokens: 0n,
      roi: 0,
      flashFee: 0n,
      slippage: 0n,
      revert: 0n,
    };
  }

  const slippage = slippageDeduction(grossProfitInTokens, slippageBps);
  const revert = revertPenalty(grossProfitInTokens, hopCount, baseRiskBps);
  const flashFee = flashLoanFee(_amountInTokens, flashLoanSource, flashLoanFeeBps);

  const netProfitInTokens = grossProfitInTokens - slippage - revert - flashFee;
  const gasCostWei = gasCostMaticWei(gasUnits, gasPriceWei);
  const netProfitMaticWei = tokensToMaticWei(netProfitInTokens > 0n ? netProfitInTokens : 0n, tokenToMaticRate);
  const netProfitAfterGasMaticWei = netProfitMaticWei - gasCostWei;

  const gasCostInTokens = maticWeiToTokens(gasCostWei, tokenToMaticRate);
  const netProfitAfterGasInTokens = netProfitInTokens - gasCostInTokens;

  const roi = roiMicroUnits(netProfitAfterGasInTokens, _amountInTokens);

  return {
    netProfitInTokens,
    gasCostWei,
    netProfitMaticWei,
    netProfitAfterGasMaticWei,
    gasCostInTokens,
    netProfitAfterGasInTokens,
    roi,
    flashFee,
    slippage,
    revert,
  };
}

// Note: invalidAssessment was removed after introducing computeProfitCore (no longer needed in hot path)
