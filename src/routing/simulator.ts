/**
 * src/routing/simulator.js — Full-protocol route simulator
 *
 * Executes a sequence of swap edges against pool state snapshots,
 * dispatching to the correct swap math based on protocol type.
 *
 * Supports:
 *   - Uniswap V2, QuickSwap V2, SushiSwap V2, Dfyn V2
 *   - Uniswap V3, QuickSwap V3, SushiSwap V3, KyberSwap Elastic
 *   - Curve StableSwap
 *   - Balancer Weighted
 *
 * Pure function — no side effects, no RPC calls.
 */

import { simulateV2Swap } from "../math/uniswap_v2.ts";
import { simulateV3Swap } from "../math/uniswap_v3.ts";
import { simulateCurveSwap } from "../math/curve.ts";
import { simulateBalancerSwap } from "../math/balancer.ts";
import { simulateDodoSwap } from "../math/dodo.ts";
import { simulateWoofiSwap } from "../math/woofi.ts";
import { workerPool } from "./worker_pool.ts";
import { EVAL_WORKER_THRESHOLD, WORKER_COUNT } from "../config/index.ts";
import { getPathHopCount } from "./path_hops.ts";
import { resolveSwapTokenIndexes } from "./swap_indices.ts";
import { isFastEvmAddress, normalizeEvmAddress } from "../utils/identity.ts";
import { toBigInt } from "../utils/bigint.ts";

import {
  BALANCER_PROTOCOLS,
  CURVE_PROTOCOLS,
  DODO_PROTOCOLS,
  normalizeProtocolKey,
  V2_PROTOCOLS,
  V3_PROTOCOLS,
  WOOFI_PROTOCOLS,
} from "../protocols/classification.ts";
import type {
  EvaluatedRoute,
  EvaluatePathsOptions,
  RouteOptimizationOptions,
  RouteSimulationResult,
  RouteState,
  RouteStateCache,
  SimulatedHopResult,
  SimulationEdge,
  SimulationPath,
} from "./simulation_types.ts";
// ─── Single-hop simulation ────────────────────────────────────

function lookupPoolState(edge: SimulationEdge, stateCache: RouteStateCache): RouteState | null {
  if (edge?.stateRef) return edge.stateRef;
  if (typeof stateCache?.get !== "function") return null;

  const normalizedPool = normalizeEvmAddress(edge?.poolAddress);
  if (normalizedPool) {
    const state = stateCache.get(normalizedPool);
    if (state !== undefined) return state;
  }
  return stateCache.get(edge?.poolAddress) ?? null;
}

function toOptionalNumber(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : undefined;
  }
  return undefined;
}

function sameRouteToken(a: unknown, b: unknown) {
  if (typeof a === "string" && typeof b === "string") {
    const fastA = isFastEvmAddress(a);
    if (fastA && a === b) return true;
    if (fastA && isFastEvmAddress(b)) {
      return a.toLowerCase() === b.toLowerCase();
    }
  }

  const tokenA = normalizeEvmAddress(a);
  const tokenB = normalizeEvmAddress(b);
  return tokenA != null && tokenA === tokenB;
}

/**
 * Simulate a single hop in a route.
 *
 * @param {import('./graph.ts').SwapEdge} edge   Swap edge
 * @param {bigint}                       amountIn
 * @param {Map<string, Object>}          stateCache  Canonical pool state map
 * @returns {{ amountOut: bigint, gasEstimate: number }}
 */
export function simulateHop(edge: SimulationEdge, amountIn: bigint, stateCache: RouteStateCache): SimulatedHopResult {
  if (amountIn <= 0n) return { amountOut: 0n, gasEstimate: 0 };

  // Prefer pre-attached state from graph edges, but normalize fallback lookups
  // for worker/serialized paths that do not carry stateRef.
  const state = lookupPoolState(edge, stateCache);

  if (!state) {
    return { amountOut: 0n, gasEstimate: 0 };
  }

  const protocol = normalizeProtocolKey(edge.protocol);

  // V3: use pre-attached swapFn if available (highest fidelity)
  if (edge.swapFn && edge.stateRef) {
    return edge.swapFn(edge.stateRef, amountIn, edge.zeroForOne, toOptionalNumber(edge.fee));
  }

  if (V2_PROTOCOLS.has(protocol)) {
    const feeNum = toBigInt(state.fee, 997n);
    const feeDen = toBigInt(state.feeDenominator, 1000n);
    return simulateV2Swap(state, amountIn, edge.zeroForOne, feeNum, feeDen);
  }

  if (V3_PROTOCOLS().has(protocol)) {
    return simulateV3Swap(state, amountIn, edge.zeroForOne, toOptionalNumber(edge.fee));
  }

  if (CURVE_PROTOCOLS.has(protocol)) {
    const indexes = resolveSwapTokenIndexes(edge, state);
    if (!indexes) {
      return { amountOut: 0n, gasEstimate: 0 };
    }
    return simulateCurveSwap(amountIn, state, indexes.tokenInIdx, indexes.tokenOutIdx);
  }

  if (BALANCER_PROTOCOLS.has(protocol)) {
    const indexes = resolveSwapTokenIndexes(edge, state);
    if (!indexes) {
      return { amountOut: 0n, gasEstimate: 0 };
    }
    return simulateBalancerSwap(amountIn, state, indexes.tokenInIdx, indexes.tokenOutIdx);
  }

  if (DODO_PROTOCOLS.has(protocol)) {
    return simulateDodoSwap(state, amountIn, edge.zeroForOne);
  }

  if (WOOFI_PROTOCOLS.has(protocol)) {
    const indexes = resolveSwapTokenIndexes(edge, state);
    if (!indexes) {
      return { amountOut: 0n, gasEstimate: 0 };
    }
    return simulateWoofiSwap(amountIn, state, indexes.tokenInIdx, indexes.tokenOutIdx);
  }

  console.warn(`[simulator] Unsupported protocol: ${protocol}`);
  return { amountOut: 0n, gasEstimate: 0 };
}

// ─── Multi-hop simulation ─────────────────────────────────────

/**
 * @typedef {Object} RouteSimResult
 * @property {bigint}   amountIn    Initial input amount
 * @property {bigint}   amountOut   Final output amount
 * @property {bigint}   profit      amountOut - amountIn (can be negative)
 * @property {boolean}  profitable  profit > 0
 * @property {bigint[]} hopAmounts  Amount at each hop boundary
 * @property {number}   totalGas    Total estimated gas
 * @property {string[]} poolPath    Ordered pool addresses
 * @property {string[]} tokenPath   Ordered token addresses (length = hops + 1)
 * @property {string[]} protocols   Protocol names per hop
 * @property {number}   hopCount    Canonical hop count derived from traversed edges
 */

/**
 * Simulate a route (sequence of swaps) and return amounts, profit, and gas.
 *
 * @param {SimulationPath} path Route path (startToken + edges)
 * @param {bigint} amountIn Starting input amount
 * @param {Map<string, Object>} stateCache Canonical pool state map
 * @returns {RouteSimResult}
 */
export function simulateRoute(path: SimulationPath, amountIn: bigint, stateCache: RouteStateCache): RouteSimulationResult {
  return simulateRouteUncached(path, amountIn, stateCache);
}

/**
 * Simulate a route (sequence of swaps) without caching.
 * Exported so the predictive cache can call it directly without contaminating
 * the hot-path cache with pre-computed (potentially stale) results.
 */
export function simulateRouteUncached(path: SimulationPath, amountIn: bigint, stateCache: RouteStateCache): RouteSimulationResult {
  const hopCount = getPathHopCount(path);
  const hopAmounts = [amountIn];
  const poolPath: string[] = [];
  const tokenPath = [path.startToken];
  const protocols: string[] = [];
  let totalGas = 0;
  let current = amountIn;
  let expectedTokenIn = path.startToken;

  // Flash loan callback overhead: ~75k for Balancer (primary flash loan source).
  // All arbitrage in this system uses flash loans as the capital source.
  const FLASH_LOAN_OVERHEAD = 75_000;
  totalGas += FLASH_LOAN_OVERHEAD;

  // Base transaction overhead: ~21k gas for the transaction itself
  const BASE_TX_GAS = 21_000;
  totalGas += BASE_TX_GAS;

  if (!Array.isArray(path?.edges) || path.edges.length === 0 || hopCount !== path.edges.length) {
    current = 0n;
  }

  for (const edge of current > 0n ? path.edges : []) {
    if (!sameRouteToken(edge.tokenIn, expectedTokenIn)) {
      current = 0n;
      break;
    }

    const { amountOut, gasEstimate } = simulateHop(edge, current, stateCache);

    current = amountOut;
    hopAmounts.push(amountOut);
    poolPath.push(edge.poolAddress);
    tokenPath.push(edge.tokenOut);
    protocols.push(edge.protocol);
    totalGas += gasEstimate;
    expectedTokenIn = edge.tokenOut;

    if (amountOut === 0n) break; // No point continuing
  }

  if (current > 0n && !sameRouteToken(expectedTokenIn, path.startToken)) {
    current = 0n;
  }

  const profit = current - amountIn;

  return {
    amountIn,
    amountOut: current,
    profit,
    profitable: profit > 0n,
    hopAmounts,
    totalGas,
    poolPath,
    tokenPath,
    protocols,
    hopCount,
  };
}

/**
 * Find the optimal input amount for a route using ternary search.
 *
 * @param {import('./finder.ts').ArbPath} path
 * @param {Map<string, Object>}           stateCache
 * @param {Object} [options]
 * @param {bigint} [options.minAmount=1000n]
 * @param {bigint} [options.maxAmount]
 * @param {number} [options.iterations=40]
 * @returns {RouteSimResult|null}   Best result, or null if no profitable amount
 */
export function optimizeInputAmount(
  path: SimulationPath,
  stateCache: RouteStateCache,
  options: RouteOptimizationOptions = {},
): RouteSimulationResult | null {
  const {
    // 10¹² wei ≈ 0.000001 tokens for 18-decimal pools.
    // Smaller amounts produce zero output on any pool with meaningful reserves,
    // wasting ternary search iterations in the sub-profitable range.
    minAmount = 10n ** 12n,
    maxAmount = 10n ** 24n,
    iterations,
    scorer = (result: RouteSimulationResult) => result.profit,
    accept = (result: RouteSimulationResult) => result.profitable,
  } = options;

  // Adaptive iteration count: wider ranges need more iterations for precision.
  // Each ternary step narrows range by 3×. For a 10²⁴ range, 20 steps → ~10¹⁰ precision.
  // For a 10¹⁰ range, 14 steps suffice. Clamp to [12, 24].
  const rangeWidth = maxAmount > minAmount ? maxAmount - minAmount : 1n;
  const rangeDigits = rangeWidth.toString().length;
  const adaptiveIterations = Math.max(12, Math.min(24, iterations ?? rangeDigits + 8));
  const effectiveIterations = iterations ?? adaptiveIterations;

  let lo = minAmount;
  let hi = maxAmount;
  let best: RouteSimulationResult | null = null;
  let bestScore: bigint | undefined;
  const evaluationCache = new Map<bigint, { result: RouteSimulationResult; score: bigint }>();

  function evaluateAmount(amount: bigint) {
    const cached = evaluationCache.get(amount);
    if (cached) return cached;

    const result = simulateRoute(path, amount, stateCache);
    const score = scorer(result);
    const evaluated = { result, score };
    evaluationCache.set(amount, evaluated);
    return evaluated;
  }

  for (let i = 0; i < effectiveIterations; i++) {
    const third = (BigInt(hi) - BigInt(lo)) / 3n;
    if (third <= 0n) break;

    const m1 = lo + third;
    const m2 = hi - third;

    const { result: r1, score: s1 } = evaluateAmount(m1);
    const { result: r2, score: s2 } = evaluateAmount(m2);

    if (s1 > s2) {
      hi = m2;
      if (!best || bestScore == null || s1 > bestScore) {
        best = r1;
        bestScore = s1;
      }
    } else {
      lo = m1;
      if (!best || bestScore == null || s2 > bestScore) {
        best = r2;
        bestScore = s2;
      }
    }
  }

  // Final evaluation at the narrowed interval boundaries + midpoint.
  for (const amount of [lo, (lo + hi) / 2n, hi]) {
    if (amount <= 0n) continue;
    const { result, score } = evaluateAmount(amount);
    if (!best || bestScore == null || score > bestScore) {
      best = result;
      bestScore = score;
    }
  }

  return best && accept(best) ? best : null;
}

/**
 * Evaluate a batch of paths and return profitable ones sorted by profit.
 *
 * @param {import('./finder.ts').ArbPath[]} paths
 * @param {Map<string, Object>}             stateCache
 * @param {bigint}                          testAmount  Quick test amount
 * @param {Object} [options]
 * @param {boolean} [options.optimize=false]  Run ternary search on profitable paths
 * @returns {Array<{ path: Object, result: RouteSimResult }>}
 */
export function evaluatePaths<TPath extends SimulationPath>(
  paths: TPath[],
  stateCache: RouteStateCache,
  testAmount: bigint,
  options: EvaluatePathsOptions = {},
): Array<EvaluatedRoute<TPath>> {
  const { optimize = false } = options;
  const profitable: Array<EvaluatedRoute<TPath>> = [];

  for (const path of paths) {
    let result = simulateRoute(path, testAmount, stateCache);

    if (result.profitable) {
      if (optimize) {
        const optimized = optimizeInputAmount(path, stateCache);
        if (optimized) result = optimized;
      }
      profitable.push({ path, result });
    }
  }

  profitable.sort((a, b) => {
    if (b.result.profit > a.result.profit) return 1;
    if (b.result.profit < a.result.profit) return -1;
    return 0;
  });

  return profitable;
}

/**
 * Evaluate a batch of paths in parallel using the persistent WorkerPool.
 *
 * Falls back to synchronous evaluation when the path count is below the
 * configured threshold (avoids IPC overhead for small batches).
 *
 * @param {import('./finder.ts').ArbPath[]} paths
 * @param {Map<string, Object>}             stateCache
 * @param {bigint}                          testAmount
 * @param {Object} [options]
 * @param {number} [options.workerCount]    Ignored — pool size is set at startup
 * @returns {Promise<Array<{ path: Object, result: RouteSimResult }>>}
 */
export async function evaluatePathsParallel<TPath extends SimulationPath>(
  paths: TPath[],
  stateCache: RouteStateCache,
  testAmount: bigint,
  options: EvaluatePathsOptions = {},
): Promise<Array<EvaluatedRoute<TPath>>> {
  const { optimize = false } = options;

  // Below the threshold the IPC serialisation overhead exceeds the parallelism gain
  if (paths.length < EVAL_WORKER_THRESHOLD || WORKER_COUNT < 2) {
    return evaluatePaths(paths, stateCache, testAmount, { optimize });
  }

  return workerPool.evaluate(paths, stateCache, testAmount, { optimize });
}
