/**
 * src/routing/score_route.js — Route scoring and ranking
 *
 * Assigns a numeric score to a simulated route result to enable
 * fast selection of the best opportunity before the full execution-grade
 * profitability checks in profit/compute.js.
 *
 * Scoring factors (weighted):
 *   1. Raw profit after a lightweight gas normalization
 *   2. Profit/input ratio (capital efficiency)
 *   3. Gas estimate (lower is better)
 *   4. Number of hops (fewer is safer)
 *   5. Cross-protocol diversity bonus
 *
 * The score is dimensionless and ranking-only.
 * Use profit/compute.js for absolute execution decisions.
 */

import { getPathHopCount } from "./path_hops.ts";
import { gasCostInTokenUnits, DEFAULT_SLIPPAGE_BPS, BPS_DENOM } from "../arb/profit_compute.ts";
import { bigintToApproxNumber } from "../utils/bigint.ts";
import type { RouteResultCore, RouteResultTrace } from "./simulation_types.ts";
import { oracle } from "../execution/gas.ts";
import { DEFAULT_GAS_PRICE_WEI } from "../config/index.ts";

// ─── Gas cost helpers ────────────────────────────────────────

function scaledRatioToApproxNumber(numerator: bigint, denominator: bigint, scale = 1_000_000n) {
  if (denominator <= 0n) return -Infinity;
  return bigintToApproxNumber((numerator * scale) / denominator);
}

/**
 * Estimate gas cost in wei.
 *
 * @param {number} gasEstimate   Estimated gas units
 * @param {bigint} [gasPriceWei] Gas price in wei (default 30 gwei)
 * @returns {bigint | null}
 */
export function estimateGasCostWei(gasEstimate: number, gasPriceWei?: bigint) {
  const price = gasPriceWei ?? DEFAULT_GAS_PRICE_WEI;
  if (!Number.isFinite(gasEstimate) || gasEstimate < 0) return null;
  if (!Number.isSafeInteger(gasEstimate)) return null;
  if (price <= 0n) return null;
  return BigInt(gasEstimate) * price;
}

export function gasCostInStartTokenUnits(gasCostWei: bigint, tokenToMaticRate?: bigint | null) {
  if (tokenToMaticRate == null) return null;
  if (tokenToMaticRate <= 0n) return null;
  try {
    return gasCostInTokenUnits(gasCostWei, tokenToMaticRate);
  } catch {
    return null;
  }
}

// ─── Route scorer ─────────────────────────────────────────────

/**
 * @typedef {Object} ScoredRoute
 * @property {Object} path         ArbPath
 * @property {Object} result       RouteResult from simulateRoute
 * @property {bigint} netProfit    profit - gas cost
 * @property {number} score        Composite score (higher is better)
 * @property {number} roi          Profit / amountIn as a fraction * 1e6 (μ-units)
 */

/**
 * Score a single route result.
 *
 * @param {Object} path           ArbPath
 * @param {Object} result         RouteResult
 * @param {Object} [options]
 * @param {bigint} [options.gasPriceWei]     Gas price override
 * @param {bigint | null} [options.tokenToMaticRate]  1 raw start-token unit in MATIC wei
 * @param {bigint} [options.minNetProfit]    Reject routes with netProfit below this
 * @returns {ScoredRoute|null}    null if route fails minimum thresholds
 */
export function scoreRoute(path: RouteLike, result: RouteResultLike, options: ScoreOptions = {}): ScoredRoute | null {
  const { gasPriceWei: optionGasPrice, tokenToMaticRate = null, minNetProfit = 0 } = options;
  const gasPriceWei = optionGasPrice ?? oracle.getFees().effectiveGasPriceWei;

  // Fast-fail checks ordered by cost (cheapest first)
  if (!result.profitable || result.profit <= 0n) return null;
  if (result.amountIn <= 0n) return null;
  if (tokenToMaticRate != null && tokenToMaticRate < 0n) return null;
  if (gasPriceWei != null && gasPriceWei < 0n) return null;
  if (minNetProfit < 0n) return null;

  const hopCount = getPathHopCount(path);
  if (!Number.isSafeInteger(hopCount) || hopCount < 1) return null;

  // Validate profit consistency (amountOut - amountIn should equal profit)
  if (result.amountOut != null && result.profit !== result.amountOut - result.amountIn) return null;
  if (!Number.isFinite(result.totalGas) || result.totalGas < 0) return null;

  const gasCostWei = estimateGasCostWei(result.totalGas, gasPriceWei);
  if (gasCostWei == null) return null;
  const gasCostInTokens = gasCostInStartTokenUnits(gasCostWei, tokenToMaticRate);

  // Slippage-adjusted profit: deduct 50 bps (0.5%) from gross output
  const adjustedOut = (result.amountOut * (BPS_DENOM - DEFAULT_SLIPPAGE_BPS)) / BPS_DENOM;
  const slippageAdjustedProfit = adjustedOut - result.amountIn;
  const profitForRanking = slippageAdjustedProfit > 0n ? slippageAdjustedProfit : 0n;

  const netProfit = gasCostInTokens == null ? profitForRanking : profitForRanking - gasCostInTokens;
  if (netProfit < minNetProfit) return null;

  const roiProfit = gasCostInTokens == null ? profitForRanking : netProfit;
  const roi = scaledRatioToApproxNumber(roiProfit, result.amountIn);

  // Hop penalty: each hop beyond 2 reduces score. 3-hop = 0.5, 4-hop = 1.0, etc.
  const hopPenalty = (hopCount - 2) * 0.5;
  // Gas penalty: routes using >90k gas above baseline get penalized
  const gasPenalty = Math.max(0, result.totalGas - 90_000) / 100_000;
  // Protocol diversity bonus: cross-protocol arbs are harder to replicate
  const protocols = new Set(path.edges.map((e: { protocol: string }) => e.protocol));
  const diversityBonus = protocols.size > 1 ? 0.2 : 0;

  // Composite score: balance ROI, normalized profit, diversity, minus hop/gas penalties
  // Normalize netProfit to MATIC-wei using tokenToMaticRate so profits from tokens
  // with different decimals (USDC=6, WMATIC=18) are scored comparably.
  const netProfitInMaticWei = tokenToMaticRate != null && tokenToMaticRate > 0n ? netProfit * tokenToMaticRate : null;
  const normalizedProfitForScore =
    netProfitInMaticWei != null ? bigintToApproxNumber(netProfitInMaticWei, 18) : bigintToApproxNumber(netProfit, 12);
  const score = roi * 0.6 + normalizedProfitForScore * 0.3 + diversityBonus * 10 - hopPenalty * 5 - gasPenalty * 3;

  return { path, result, netProfit, score, roi, gasCostInTokens };
}

/**
 * Score and rank multiple route results.
 *
 * @param {Array<{ path: Object, result: Object }>} candidates
 * @param {Object} [options]
 * @param {bigint} [options.gasPriceWei]
 * @param {bigint | null} [options.tokenToMaticRate]
 * @param {bigint} [options.minNetProfit]
 * @returns {ScoredRoute[]}  Sorted descending by score
 */
export function rankRoutes(candidates: Array<{ path: RouteLike; result: RouteResultLike }>, options: ScoreOptions = {}): ScoredRoute[] {
  const scored: ScoredRoute[] = [];

  for (const { path, result } of candidates) {
    const s = scoreRoute(path, result, options);
    if (s) scored.push(s);
  }

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Select the single best route from candidates.
 * Uses a single-pass max search instead of full sort — O(N) vs O(N log N).
 */
export function selectBestRoute(
  candidates: Array<{ path: RouteLike; result: RouteResultLike }>,
  options: ScoreOptions = {},
): ScoredRoute | null {
  let best: ScoredRoute | null = null;

  for (const { path, result } of candidates) {
    const s = scoreRoute(path, result, options);
    if (s && (!best || s.score > best.score)) {
      best = s;
    }
  }

  return best;
}
export type RouteLike = {
  hopCount: number;
  edges: Array<{ protocol: string }>;
};

export type RouteResultLike = RouteResultCore & Pick<RouteResultTrace, "profitable">;

export type ScoreOptions = {
  gasPriceWei?: bigint;
  tokenToMaticRate?: bigint | null;
  minNetProfit?: bigint;
};

export type ScoredRoute = {
  path: RouteLike;
  result: RouteResultLike;
  netProfit: bigint;
  score: number;
  roi: number;
  gasCostInTokens: bigint | null;
};
