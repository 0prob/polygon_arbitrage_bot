import { computeProfit } from "../arb/profit_compute.ts";
import { getPathHopCount } from "../routing/path_hops.ts";
import type { RouteResultCore, RouteResultTrace } from "../routing/simulation_types.ts";
import type { RouteIdentityEdge } from "../routing/route_identity.ts";
import {
  PROBE_BY_DECIMALS,
  DEFAULT_PROBE_AMOUNT,
  CONFIG_DEFAULT_SLIPPAGE_BPS,
  CONFIG_DEFAULT_REVERT_RISK_BPS,
  CONFIG_DEFAULT_FLASH_LOAN_FEE_BPS,
  CONFIG_DEFAULT_MIN_PROFIT_WEI,
} from "../config/index.ts";

export type RouteResultLike = RouteResultCore &
  Partial<Pick<RouteResultTrace, "profitable" | "hopCount" | "poolPath" | "tokenPath" | "hopAmounts">>;

export type AssessmentLike = {
  shouldExecute: boolean;
  netProfit: bigint;
  netProfitAfterGas: bigint;
  roi?: number;
  rejectReason?: string;
};

export type ArbPathLike = {
  startToken: string;
  edges: Array<RouteIdentityEdge & {
    protocol: string;
    zeroForOne: boolean;
  }>;
  hopCount: number;
  logWeight: unknown;
  cumulativeFeesBps?: number;
};

export type CandidateEntry = {
  path: ArbPathLike;
  result: RouteResultLike;
  assessment?: AssessmentLike;
};

export type ExecutableCandidate = CandidateEntry & { assessment: AssessmentLike };

type AssessmentConfig = {
  minProfitWei: bigint;
  slippageBps?: bigint;
  revertRiskBps?: bigint;
  flashLoanFeeBps?: bigint;
};

/** Minimum net profit threshold in MATIC wei (≈ $0.50 at ~2500 MATIC/ETH). */
const MIN_PROFIT_WEI_DEFAULT = CONFIG_DEFAULT_MIN_PROFIT_WEI;

const ASSESSMENT_DEFAULT_SLIPPAGE_BPS = CONFIG_DEFAULT_SLIPPAGE_BPS;
const ASSESSMENT_DEFAULT_REVERT_RISK_BPS = CONFIG_DEFAULT_REVERT_RISK_BPS;
const ASSESSMENT_DEFAULT_FLASH_LOAN_FEE_BPS = CONFIG_DEFAULT_FLASH_LOAN_FEE_BPS;

const MIN_PROBE_AMOUNT = 1_000n;

/**
 * Convert a MATIC-wei minimum profit to the start-token's raw units.
 * Uses floor division; returns 0 if rate is unavailable.
 */
export function minProfitInTokenUnits(tokenToMaticRate: bigint, minProfitWei: bigint): bigint {
  if (tokenToMaticRate <= 0n) return 0n;
  return (minProfitWei + tokenToMaticRate - 1n) / tokenToMaticRate;
}

/**
 * Get a reasonable minimum probe amount based on token decimals.
 * Returns the largest probe amount that still represents a meaningful
 * value for the given decimal precision.
 */
export function getMinProbeForDecimals(decimals: number | undefined): bigint {
  if (decimals != null && PROBE_BY_DECIMALS[decimals] != null) {
    return PROBE_BY_DECIMALS[decimals];
  }
  return DEFAULT_PROBE_AMOUNT;
}

export function getOptimizationOptions(quickResult: RouteResultLike | null | undefined) {
  const amountIn = quickResult?.amountIn ?? 10n ** 18n;
  const minAmount = amountIn > 10n ? amountIn / 10n : MIN_PROBE_AMOUNT;
  const maxAmount = amountIn * 8n > minAmount ? amountIn * 8n : minAmount * 8n;
  return {
    minAmount: minAmount > MIN_PROBE_AMOUNT ? minAmount : MIN_PROBE_AMOUNT,
    maxAmount,
    iterations: 24,
  };
}

export function assessRouteResult(
  path: ArbPathLike,
  routeResult: RouteResultLike,
  gasPriceWei: bigint,
  tokenToMaticRate: bigint,
  config: AssessmentConfig,
) {
  // Fix #7: pass null when rate is 0 (oracle cold/stale) so computeProfit
  // skips gas deduction gracefully instead of returning invalidAssessment.
  // A zero rate means we cannot convert gas cost to token units — rather than
  // hard-rejecting, allow the candidate to pass on gross profit alone so it
  // can proceed to execution where a fresh rate will be re-checked.
  const effectiveRate = tokenToMaticRate > 0n ? tokenToMaticRate : null;
  return computeProfit(routeResult, {
    gasPriceWei,
    tokenToMaticRate: effectiveRate,
    slippageBps: config.slippageBps ?? ASSESSMENT_DEFAULT_SLIPPAGE_BPS,
    revertRiskBps: config.revertRiskBps ?? ASSESSMENT_DEFAULT_REVERT_RISK_BPS,
    flashLoanFeeBps: config.flashLoanFeeBps ?? ASSESSMENT_DEFAULT_FLASH_LOAN_FEE_BPS,
    minNetProfit: minProfitInTokenUnits(tokenToMaticRate, config.minProfitWei),
    hopCount: getPathHopCount(path),
  });
}

export function getAssessmentOptimizationOptions(
  path: ArbPathLike,
  quickResult: RouteResultLike | null | undefined,
  gasPriceWei: bigint,
  tokenToMaticRate: bigint,
  config: AssessmentConfig,
) {
  // Fix #1: When tokenToMaticRate is 0 (oracle cold/stale), pass 0n so
  // assessRouteResult → computeProfit skips gas deduction gracefully.
  // The scorer uses netProfitAfterGas which equals netProfit when gas
  // can't be computed, preventing the ternary search from optimizing
  // purely on gross profit when gas data is available.
  return {
    ...getOptimizationOptions(quickResult),
    scorer: (routeResult: RouteResultLike) =>
      assessRouteResult(path, routeResult, gasPriceWei, tokenToMaticRate, config).netProfitAfterGas,
    accept: (routeResult: RouteResultLike) =>
      assessRouteResult(path, routeResult, gasPriceWei, tokenToMaticRate, config).shouldExecute,
  };
}

export type AssessmentOptimizationOptions = ReturnType<typeof getAssessmentOptimizationOptions>;

export function profitMarginBps(candidate: ExecutableCandidate) {
  if (!candidate?.result?.amountIn || candidate.result.amountIn <= 0n) return 0n;
  const netProfit = candidate.assessment?.netProfitAfterGas ?? candidate.assessment?.netProfit ?? 0n;
  if (netProfit <= 0n) return 0n;
  return (netProfit * 10_000n) / candidate.result.amountIn;
}

export function assessmentNetProfit(assessment: AssessmentLike | null | undefined) {
  if (assessment?.netProfitAfterGas != null) return assessment.netProfitAfterGas;
  return assessment?.netProfit ?? 0n;
}

export function compareAssessmentProfit(a: CandidateEntry, b: CandidateEntry) {
  const profitA = assessmentNetProfit(a?.assessment);
  const profitB = assessmentNetProfit(b?.assessment);
  if (profitB > profitA) return 1;
  if (profitB < profitA) return -1;
  return 0;
}
