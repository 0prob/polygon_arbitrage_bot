import type { RouteSimulationResult } from "../types/route.ts";

const NEG_INF_SCORE = -(2n ** 256n);

export interface OptimizeOptions {
  minAmount?: bigint;
  maxAmount?: bigint;
  iterations?: number;
  scorer?: (result: RouteSimulationResult) => bigint;
  accept?: (result: RouteSimulationResult) => boolean;
}

/**
 * Ternary search over input amount to maximize the scorer (default: profit).
 * Assumes the scorer is unimodal in amountIn over [minAmount, maxAmount].
 *
 * @param simulate - Pure function: amountIn -> RouteSimulationResult
 * @param opts - Search bounds and iteration count
 */
export function optimizeInputAmount(
  simulate: (amountIn: bigint) => RouteSimulationResult,
  opts: OptimizeOptions = {},
): RouteSimulationResult {
  const { minAmount = 1n, maxAmount = 10n ** 24n, iterations = 64, scorer = (r) => r.profit, accept = () => true } = opts;

  if (minAmount >= maxAmount) {
    return simulate(minAmount);
  }

  let lo = minAmount;
  let hi = maxAmount;
  let bestResult: RouteSimulationResult | null = null;
  let bestScore = NEG_INF_SCORE;

  for (let i = 0; i < iterations; i++) {
    if (hi - lo < 3n) break;

    const third = (hi - lo) / 3n;
    const m1 = lo + third;
    const m2 = hi - third;

    const r1 = simulate(m1);
    const r2 = simulate(m2);
    const s1 = accept(r1) ? scorer(r1) : NEG_INF_SCORE;
    const s2 = accept(r2) ? scorer(r2) : NEG_INF_SCORE;

    if (s1 > bestScore) {
      bestScore = s1;
      bestResult = r1;
    }
    if (s2 > bestScore) {
      bestScore = s2;
      bestResult = r2;
    }

    if (s1 < s2) lo = m1;
    else hi = m2;
  }

  // Final check at midpoint
  const mid = (lo + hi) / 2n;
  const rMid = simulate(mid);
  const sMid = accept(rMid) ? scorer(rMid) : NEG_INF_SCORE;
  if (sMid > bestScore && accept(rMid)) {
    bestScore = sMid;
    bestResult = rMid;
  }

  return bestResult ?? simulate(minAmount);
}
