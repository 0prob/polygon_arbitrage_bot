import { getResultHopCount } from "../routing/path_hops.ts";
import type { RouteResultCore, RouteResultTrace } from "../routing/simulation_types.ts";
import { oracle } from "../execution/gas.ts";
import { bigintToApproxNumber } from "../utils/bigint.ts";
import { divRoundingUp } from "../math/full_math.ts";
import {
  DEFAULT_GAS_PRICE_WEI,
  CONFIG_DEFAULT_MIN_PROFIT_WEI,
  CONFIG_DEFAULT_SLIPPAGE_BPS,
  CONFIG_DEFAULT_REVERT_RISK_BPS,
} from "../config/index.ts";

/**
 * src/profit/compute.js — Gas-adjusted profitability engine
 *
 * Determines whether a simulated arbitrage route is worth executing
 * after accounting for:
 *   1. Gas cost (in the network's native token, MATIC)
 *   2. Slippage risk (difference between simulated and real output)
 *   3. Revert risk (probability of on-chain failure)
 *   4. Minimum profit threshold (floor to ensure effort is worthwhile)
 *
 * All profit is expressed in the start token's raw units (bigint).
 * For cross-denomination comparison, provide a tokenToMaticRate.
 *
 * Usage:
 *   import { computeProfit } from "./compute.js";
 *   const assessment = computeProfit(routeResult, { gasPrice: 30n * 10n**9n });
 *   if (assessment.shouldExecute) { ... }
 */

// ─── Constants ──────────────────────────────────────

// Default gas price imported from constants/gas.ts

/**
 * Default slippage factor (in basis points out of 10000).
 * 50 bps = 0.5% slippage from simulation to on-chain execution.
 */
export const DEFAULT_SLIPPAGE_BPS = CONFIG_DEFAULT_SLIPPAGE_BPS;

/**
 * Default revert risk penalty (fraction of gross profit).
 * 5% probability of revert × full loss = 5% penalty.
 */
const DEFAULT_REVERT_RISK_BPS = CONFIG_DEFAULT_REVERT_RISK_BPS;

/** Basis point denominator */
export const BPS_DENOM = 10_000n;

/** Default minimum net profit in the start token's units (from centralized config) */
const DEFAULT_MIN_PROFIT = CONFIG_DEFAULT_MIN_PROFIT_WEI;

/** Default Balancer flash-loan fee in basis points. Current Polygon deployments may be 0, but keep the fee explicit. */
const DEFAULT_FLASH_LOAN_FEE_BPS = 0n;

export function gasCostInTokenUnits(gasCost: bigint, tokenToMaticRate: bigint) {
  if (gasCost < 0n) {
    throw new Error("gasCost must be >= 0");
  }
  if (tokenToMaticRate <= 0n) {
    throw new Error("tokenToMaticRate must be > 0");
  }
  return divRoundingUp(gasCost, tokenToMaticRate);
}

export function roiMicroUnits(profit: bigint, amountIn: bigint) {
  if (amountIn <= 0n) return 0;
  return bigintToApproxNumber((profit * 1_000_000n) / amountIn);
}

function invalidAssessment(routeResult: Partial<RouteResultLike>, reason: string): ProfitAssessment {
  return {
    shouldExecute: false,
    grossProfit: routeResult.profit ?? 0n,
    gasCostWei: 0n,
    gasCostInTokens: 0n,
    flashLoanFee: 0n,
    slippageDeduction: 0n,
    revertPenalty: 0n,
    netProfit: 0n,
    netProfitAfterGas: 0n,
    roi: 0,
    rejectReason: reason,
  };
}

// ─── Gas model ────────────────────────────────────────────────

/**
 * Estimate gas cost in wei.
 *
 * @param {number} gasUnits     Estimated gas consumption
 * @param {bigint} gasPriceWei  Current gas price in wei
 * @returns {bigint}            Gas cost in wei
 */
export function gasCostWei(gasUnits: number, gasPriceWei: bigint = DEFAULT_GAS_PRICE_WEI) {
  if (!Number.isSafeInteger(gasUnits) || gasUnits < 0) {
    throw new Error("gasUnits must be a finite non-negative safe integer");
  }
  return BigInt(gasUnits) * gasPriceWei;
}

// ─── Slippage model ───────────────────────────────────────────

/**
 * Apply slippage to a profit estimate.
 *
 * Reduces the expected amountOut by slippageBps, reducing net profit.
 *
 * @param {bigint} amountOut   Simulated output amount
 * @param {bigint} slippageBps Slippage in basis points (0-10000)
 * @returns {bigint}           Slippage-adjusted amountOut
 */
export function applySlippage(amountOut: bigint, slippageBps: bigint = DEFAULT_SLIPPAGE_BPS) {
  if (amountOut < 0n) {
    throw new Error("amountOut must be >= 0");
  }
  if (slippageBps < 0n || slippageBps > BPS_DENOM) {
    throw new Error("slippageBps must be between 0 and 10000");
  }
  const complement = BPS_DENOM - slippageBps;
  return (amountOut * complement) / BPS_DENOM;
}

export function flashLoanFeeInTokenUnits(amountBorrowed: bigint, feeBps: bigint = DEFAULT_FLASH_LOAN_FEE_BPS) {
  if (amountBorrowed < 0n) {
    throw new Error("amountBorrowed must be >= 0");
  }
  if (feeBps < 0n || feeBps > BPS_DENOM) {
    throw new Error("flashLoanFeeBps must be between 0 and 10000");
  }
  return divRoundingUp(amountBorrowed * feeBps, BPS_DENOM);
}

// ─── Revert risk model ────────────────────────────────────────

/**
 * Compute a revert-risk penalty on profit.
 *
 * Models the expected loss from failed transactions:
 *   penalty = grossProfit * revertRiskBps / BPS_DENOM
 *
 * Factors that increase revert risk:
 *   - Many hops (more chances for state change between simulation and execution)
 *   - Low liquidity pools (more price movement)
 *   - High profit ratio (likely arb already being front-run)
 *
 * @param {bigint} grossProfit   Gross profit before gas
 * @param {number} hopCount      Number of hops
 * @param {bigint} revertRiskBps Base revert risk in bps (configurable)
 * @returns {bigint}             Revert risk penalty
 */
export function revertRiskPenalty(grossProfit: bigint, hopCount: number, revertRiskBps: bigint = DEFAULT_REVERT_RISK_BPS) {
  if (grossProfit < 0n) {
    throw new Error("grossProfit must be >= 0");
  }
  if (!Number.isSafeInteger(hopCount) || hopCount < 1) {
    throw new Error("hopCount must be >= 1");
  }
  if (revertRiskBps < 0n || revertRiskBps > BPS_DENOM) {
    throw new Error("revertRiskBps must be between 0 and 10000");
  }
  // Increase risk for more hops: +200 bps per extra hop beyond 2
  const extraHops = BigInt(Math.max(0, hopCount - 2));
  const adjustedRisk = revertRiskBps + extraHops * 200n;
  const cappedRisk = adjustedRisk > 3000n ? 3000n : adjustedRisk; // cap at 30%

  return (grossProfit * cappedRisk) / BPS_DENOM;
}

// ─── Profitability assessment ─────────────────────────────────

/**
 * @typedef {Object} ProfitAssessment
 * @property {boolean} shouldExecute      Whether the route clears all thresholds
 * @property {bigint}  grossProfit        Raw simulated profit (amountOut - amountIn)
 * @property {bigint}  gasCostWei         Estimated gas cost in wei
 * @property {bigint}  slippageDeduction  Amount lost to slippage
 * @property {bigint}  revertPenalty      Expected loss from revert risk
 * @property {bigint}  netProfit          grossProfit - slippage - revert (in start token units)
 * @property {bigint}  netProfitAfterGas  netProfit minus gas cost (if same denomination)
 * @property {number}  roi                Net profit / amountIn (fraction * 1e6)
 * @property {string}  rejectReason       Non-empty if shouldExecute is false
 */

/**
 * Compute the full profitability assessment for a route simulation result.
 *
 * @param {Object} routeResult                 From simulateRoute()
 * @param {bigint} routeResult.amountIn
 * @param {bigint} routeResult.amountOut
 * @param {bigint} routeResult.profit
 * @param {number} routeResult.totalGas
 * @param {number} routeResult.hopCount        (optional, from path.hopCount)
 *
 * @param {Object} [options]
 * @param {bigint} [options.gasPriceWei]               Gas price override
 * @param {bigint} [options.tokenToMaticRate]          1 startToken in wei (for gas comparison)
 *                                                      If not provided, gas cost comparison is skipped.
 * @param {bigint} [options.slippageBps]               Slippage tolerance
 * @param {bigint} [options.revertRiskBps]             Revert risk
 * @param {bigint} [options.minNetProfit]              Minimum net profit threshold
 * @param {number} [options.hopCount]                  Override hop count
 *
 * @returns {ProfitAssessment}
 */
export function computeProfit(routeResult: RouteResultLike, options: ProfitOptions = {}): ProfitAssessment {
  if (!routeResult) return invalidAssessment({}, "missing route result");

  const derivedHopCount = getResultHopCount(routeResult);
  // Fix #1: when derivedHopCount is null (path metadata missing), fall back to
  // routeResult.hopCount if present, then to 2 as a safe default. The old code
  // set defaultHopCount = 0 when routeResult.hopCount existed but derivedHopCount
  // was null, which immediately failed the hopCount < 1 guard and silently
  // rejected valid routes via invalidAssessment("invalid hopCount").
  const defaultHopCount = derivedHopCount != null ? derivedHopCount : routeResult.hopCount != null ? Number(routeResult.hopCount) : 2;
  const {
    gasPriceWei: optionGasPrice,
    tokenToMaticRate = null,
    slippageBps = DEFAULT_SLIPPAGE_BPS,
    revertRiskBps = DEFAULT_REVERT_RISK_BPS,
    flashLoanFeeBps = DEFAULT_FLASH_LOAN_FEE_BPS,
    minNetProfit = DEFAULT_MIN_PROFIT,
    hopCount = defaultHopCount,
  } = options;
  const gasPriceWei = optionGasPrice ?? oracle.getFees().effectiveGasPriceWei;

  const { amountIn, amountOut, profit: grossProfit, totalGas } = routeResult;
  if (amountIn <= 0n) return invalidAssessment(routeResult, "amountIn <= 0");
  if (amountOut < 0n) return invalidAssessment(routeResult, "amountOut < 0");
  if (grossProfit !== amountOut - amountIn) return invalidAssessment(routeResult, "profit mismatch");
  if (!Number.isSafeInteger(totalGas) || totalGas < 0) return invalidAssessment(routeResult, "invalid totalGas");
  if (gasPriceWei <= 0n) return invalidAssessment(routeResult, "gasPriceWei <= 0");
  if (slippageBps < 0n || slippageBps > BPS_DENOM) return invalidAssessment(routeResult, "invalid slippageBps");
  if (revertRiskBps < 0n || revertRiskBps > BPS_DENOM) return invalidAssessment(routeResult, "invalid revertRiskBps");
  if (flashLoanFeeBps < 0n || flashLoanFeeBps > BPS_DENOM) return invalidAssessment(routeResult, "invalid flashLoanFeeBps");
  if (minNetProfit < 0n) return invalidAssessment(routeResult, "minNetProfit < 0");
  if (!Number.isSafeInteger(hopCount) || hopCount < 1) return invalidAssessment(routeResult, "invalid hopCount");
  if (tokenToMaticRate != null && tokenToMaticRate <= 0n) {
    return invalidAssessment(routeResult, "tokenToMaticRate <= 0");
  }

  // 1. Gas cost in wei
  const gasCost = gasCostWei(totalGas, gasPriceWei);

  // 2. Slippage deduction (applied to output amount)
  const adjustedOut = applySlippage(amountOut, slippageBps);
  const slippageDeduction = amountOut - adjustedOut;
  const profitAfterSlippage = adjustedOut - amountIn;

  // 3. Revert risk penalty (applied to profit after slippage to avoid double-counting)
  const revertPenalty = revertRiskPenalty(profitAfterSlippage > 0n ? profitAfterSlippage : 0n, hopCount, revertRiskBps);

  const netProfitBeforeFlashLoanFee = profitAfterSlippage - revertPenalty;
  const flashLoanFee = flashLoanFeeInTokenUnits(amountIn, flashLoanFeeBps);
  const netProfit = netProfitBeforeFlashLoanFee - flashLoanFee;

  // 4. Gas cost deduction (only if we know the token/MATIC exchange rate)
  let netProfitAfterGas = netProfit;
  let gasCostInTokens = 0n;
  let gasWiped = false;
  if (tokenToMaticRate != null && tokenToMaticRate > 0n) {
    gasCostInTokens = gasCostInTokenUnits(gasCost, tokenToMaticRate);
    netProfitAfterGas = netProfit - gasCostInTokens;
    // Gas sanity: if gas cost alone (in MATIC wei) already exceeds minNetProfit,
    // the route is uneconomical regardless of token unit conversion quirks.
    if (gasCost > 0n && minNetProfit > 0n && gasCost >= minNetProfit) {
      gasWiped = true;
    }
  }

  // 5. ROI (net profit / input, in micro-units = parts per million)
  const roiBase = tokenToMaticRate != null && tokenToMaticRate > 0n ? netProfitAfterGas : netProfit;
  const roi = roiMicroUnits(roiBase, amountIn);

  // 6. Threshold checks
  let shouldExecute = true;
  let rejectReason = "";

  const thresholdProfit = tokenToMaticRate != null && tokenToMaticRate > 0n ? netProfitAfterGas : netProfit;

  if (gasWiped) {
    shouldExecute = false;
    rejectReason = "gas cost in MATIC wei already exceeds min profit threshold";
  } else if (grossProfit <= 0n) {
    shouldExecute = false;
    rejectReason = "gross profit <= 0";
  } else if (profitAfterSlippage <= 0n) {
    shouldExecute = false;
    rejectReason = "profit wiped by slippage";
  } else if (flashLoanFee > 0n && netProfitBeforeFlashLoanFee <= flashLoanFee) {
    shouldExecute = false;
    rejectReason = "flash-loan fee exceeds net profit";
  } else if (thresholdProfit < minNetProfit) {
    shouldExecute = false;
    rejectReason = `net profit ${thresholdProfit} < minimum ${minNetProfit}`;
  } else if (tokenToMaticRate != null && netProfitAfterGas <= 0n) {
    shouldExecute = false;
    rejectReason = "gas cost exceeds net profit";
  }

  return {
    shouldExecute,
    grossProfit,
    gasCostWei: gasCost,
    gasCostInTokens,
    flashLoanFee,
    slippageDeduction,
    revertPenalty,
    netProfit,
    netProfitAfterGas,
    roi,
    rejectReason,
  };
}

/**
 * Quick pass/fail check for a route, given current market conditions.
 *
 * @param {Object} routeResult    From simulateRoute()
 * @param {Object} marketContext
 * @param {bigint} marketContext.gasPriceWei
 * @param {bigint} [marketContext.tokenToMaticRate]
 * @param {bigint} [marketContext.minNetProfit]
 * @returns {boolean}
 */
export function isProfitable(routeResult: RouteResultLike, marketContext: ProfitOptions = {}) {
  const assessment = computeProfit(routeResult, marketContext);
  return assessment.shouldExecute;
}

type RouteResultLike = RouteResultCore & Partial<Pick<RouteResultTrace, "hopCount" | "poolPath" | "tokenPath" | "hopAmounts">>;

type ProfitOptions = {
  gasPriceWei?: bigint;
  tokenToMaticRate?: bigint | null;
  slippageBps?: bigint;
  revertRiskBps?: bigint;
  flashLoanFeeBps?: bigint;
  minNetProfit?: bigint;
  hopCount?: number;
};

type ProfitAssessment = {
  shouldExecute: boolean;
  grossProfit: bigint;
  gasCostWei: bigint;
  gasCostInTokens: bigint;
  flashLoanFee: bigint;
  slippageDeduction: bigint;
  revertPenalty: bigint;
  netProfit: bigint;
  netProfitAfterGas: bigint;
  roi: number;
  rejectReason: string;
};
