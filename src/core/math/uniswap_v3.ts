/**
 * src/math/uniswap_v3.js — Optimized Uniswap V3 swap simulator
 *
 * Deterministic off-chain simulation of a V3 swap.
 * Optimized for high-frequency trading (HFT) performance:
 *   - Pre-sorts and caches initialized ticks to avoid O(N log N) sorts in hot path.
 *   - Uses binary search (O(log N)) to find the next initialized tick.
 *
 * This module is a pure function — it takes a pool state snapshot
 * and returns the swap result without side effects.
 */

import { getSqrtRatioAtTick, getTickAtSqrtRatioInRange, MIN_TICK, MAX_TICK, MIN_SQRT_RATIO, MAX_SQRT_RATIO } from "./tick_math.ts";
import { computeSwapStep } from "./swap_math.ts";
import { toBigIntOrNull } from "../utils/bigint.ts";

// Pre-computed price limits to avoid BigInt allocation in hot path
const SQRT_PRICE_LIMIT_ZERO_FOR_ONE = MIN_SQRT_RATIO + 1n;
const SQRT_PRICE_LIMIT_ONE_FOR_ZERO = MAX_SQRT_RATIO - 1n;

// ─── Optimized Tick Navigation ──────────────────────────────────

type V3PoolStateLike = Record<string, unknown>;
type V3TickData = Record<string, unknown>;

const SORTED_TICKS_CACHE_MAX = 500;
const sortedTicksCache = new Map<
  string,
  {
    tickVersion: number;
    ticksRef: Map<unknown, unknown>;
    ticksSize: number;
    sortedTicks: number[];
  }
>();
// Pure size-capped cache (FIFO-ish via insertion order). No O(n) arrays or renumbering
// ever in the hot path. Eviction only happens on new inserts when full.

function asPoolState(value: unknown): V3PoolStateLike {
  return value != null && typeof value === "object" ? (value as V3PoolStateLike) : {};
}

function asTickData(value: unknown): V3TickData | null {
  return value != null && typeof value === "object" ? (value as V3TickData) : null;
}

function poolCacheKey(pool: V3PoolStateLike) {
  if (typeof pool.poolId === "string" && pool.poolId) return pool.poolId;
  const addr = typeof pool.address === "string" ? pool.address.toLowerCase() : "";
  if (addr) return addr;
  return String(pool.pool_address ?? "");
}

/**
 * Find the next initialized tick in the swap direction using binary search.
 *
 * @param {number[]} sortedTicks  Pre-sorted array of initialized tick indices
 * @param {number}   currentTick  Current pool tick
 * @param {boolean}  zeroForOne   Direction (true = decreasing, false = increasing)
 * @returns {number|null}
 */
function nextInitializedTickOptimized(sortedTicks: readonly number[], currentTick: number, zeroForOne: boolean) {
  if (sortedTicks.length === 0) return null;

  let low = 0;
  let high = sortedTicks.length - 1;
  let result: number | null = null;

  if (zeroForOne) {
    // Price decreasing: find largest tick <= currentTick
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (sortedTicks[mid] <= currentTick) {
        result = sortedTicks[mid];
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
  } else {
    // Price increasing: find smallest tick > currentTick
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (sortedTicks[mid] > currentTick) {
        result = sortedTicks[mid];
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
  }

  return result;
}

function getSortedTicks(state: V3PoolStateLike) {
  const ticks = state.ticks;
  if (!(ticks instanceof Map) || ticks.size === 0) return [];

  const tickVersion = Number.isFinite(Number(state?.tickVersion)) ? Number(state.tickVersion) : 0;
  const key = poolCacheKey(state);
  if (key) {
    const cached = sortedTicksCache.get(key);
    if (cached && cached.ticksRef === ticks && cached.tickVersion === tickVersion && cached.ticksSize === ticks.size) {
      return cached.sortedTicks;
    }
  }

  const sortedTicks = Array.from(ticks.keys())
    .filter((tick): tick is number => Number.isInteger(tick))
    .sort((a, b) => a - b);
  if (key) {
    // Pure size-capped eviction (O(1) on the Map using insertion order).
    // No auxiliary arrays, no renumbering, no work on cache hits.
    // This is the final form for the hot path (thousands of V3 simulateHop calls per 200 ms).
    if (!sortedTicksCache.has(key) && sortedTicksCache.size >= SORTED_TICKS_CACHE_MAX) {
      // Delete the oldest inserted entry (Map preserves insertion order)
      const it = sortedTicksCache.keys().next();
      if (!it.done) {
        sortedTicksCache.delete(it.value);
      }
    }
    sortedTicksCache.set(key, {
      tickVersion,
      ticksRef: ticks,
      ticksSize: ticks.size,
      sortedTicks,
    });
  }
  return sortedTicks;
}

// ─── V3 Swap Simulator ───────────────────────────────────────

/**
 * Simulate a Uniswap V3 exactInput swap.
 *
 * @param {Object} state             Pool state snapshot
 * @param {bigint} amountIn          Amount of input token (positive)
 * @param {boolean} zeroForOne       Direction: true = token0→token1, false = token1→token0
 * @param {number} [feeOverride]     Optional fee tier override
 * @returns {{ amountOut: bigint, sqrtPriceX96After: bigint, tickAfter: number, gasEstimate: number }}
 */
export function simulateV3Swap(state: unknown, amountIn: bigint, zeroForOne: boolean, feeOverride?: number) {
  const pool = asPoolState(state);
  const sqrtPriceInitial = toBigIntOrNull(pool.sqrtPriceX96);
  const liquidityInitial = toBigIntOrNull(pool.liquidity);
  const feePips = toBigIntOrNull(feeOverride ?? pool.fee);
  const fallbackSqrtPrice = sqrtPriceInitial ?? 0n;
  const fallbackTick = Number.isInteger(pool.tick) ? Number(pool.tick) : 0;

  if (
    amountIn <= 0n ||
    !pool.initialized ||
    sqrtPriceInitial == null ||
    sqrtPriceInitial < MIN_SQRT_RATIO ||
    sqrtPriceInitial >= MAX_SQRT_RATIO ||
    liquidityInitial == null ||
    liquidityInitial <= 0n ||
    feePips == null ||
    feePips < 0n ||
    feePips >= 1_000_000n
  ) {
    return {
      amountOut: 0n,
      sqrtPriceX96After: fallbackSqrtPrice,
      tickAfter: fallbackTick,
      gasEstimate: 0,
      shallow: false,
      maxReliableAmountIn: 0n,
    };
  }

  // Price limit: min or max sqrt ratio depending on direction
  const sqrtPriceLimitX96 = zeroForOne ? SQRT_PRICE_LIMIT_ZERO_FOR_ONE : SQRT_PRICE_LIMIT_ONE_FOR_ZERO;

  const sortedTicks = getSortedTicks(pool);
  const ticks = pool.ticks instanceof Map ? pool.ticks : null;

  // Mutable swap state
  let sqrtPriceX96 = sqrtPriceInitial;
  let tick = fallbackTick;
  let liquidity = liquidityInitial;
  let amountRemaining = amountIn; // exactIn: positive
  let amountCalculated = 0n; // accumulated output
  let ticksCrossed = 0;

  // If we have no ticks loaded, we must artificially bound the swap to the current tick interval
  // to avoid assuming infinite liquidity up to the absolute price limits.
  const hasTicks = sortedTicks.length > 0;

  // Cumulative tick movement limiter for pools without tick data.
  // Without tick data, liquidity is assumed constant across all steps, which massively
  // over-estimates output for large price moves. Bound total movement to prevent this.
  const MAX_CUMULATIVE_TICK_MOVE = 500;
  const initialTick = tick;

  // Safety: max iterations to prevent infinite loops
  const MAX_ITERATIONS = 500;

  /** Input consumed before the first synthetic boundary (no-tick pools only). */
  let maxReliableAmountIn = amountIn;
  let tickDataExhausted = false;

  for (let i = 0; i < MAX_ITERATIONS && amountRemaining > 0n; i++) {
    // Find the next initialized tick boundary
    let nextTick = nextInitializedTickOptimized(sortedTicks, tick, zeroForOne);

    if (nextTick === null && hasTicks) {
      tickDataExhausted = true;
      maxReliableAmountIn = amountIn - amountRemaining;
      break;
    }

    if (nextTick === null && !hasTicks) {
      const tickStep = Number.isFinite(Number(pool.tickStepOverride)) ? Number(pool.tickStepOverride) : 200;
      const rawNext = zeroForOne ? tick - tickStep : tick + tickStep;
      const cumulativeFromStart = zeroForOne ? initialTick - rawNext : rawNext - initialTick;

      if (cumulativeFromStart > MAX_CUMULATIVE_TICK_MOVE) {
        const boundTick = zeroForOne ? initialTick - MAX_CUMULATIVE_TICK_MOVE : initialTick + MAX_CUMULATIVE_TICK_MOVE;
        // Can't move further if already at/past bound
        if (zeroForOne ? boundTick >= tick : boundTick <= tick) break;
        nextTick = boundTick;
      } else {
        nextTick = rawNext;
      }
      if (nextTick < MIN_TICK) nextTick = MIN_TICK;
      if (nextTick > MAX_TICK) nextTick = MAX_TICK;
    }

    // Determine the sqrt price at the next tick boundary
    const sqrtPriceNextTickX96 = nextTick !== null ? getSqrtRatioAtTick(nextTick) : sqrtPriceLimitX96;

    // Clamp to price limit
    const sqrtRatioTargetX96 = zeroForOne
      ? sqrtPriceNextTickX96 < sqrtPriceLimitX96
        ? sqrtPriceLimitX96
        : sqrtPriceNextTickX96
      : sqrtPriceNextTickX96 > sqrtPriceLimitX96
        ? sqrtPriceLimitX96
        : sqrtPriceNextTickX96;

    // Compute swap within this tick range
    const step = computeSwapStep(sqrtPriceX96, sqrtRatioTargetX96, liquidity, amountRemaining, feePips);

    // Update state
    sqrtPriceX96 = step.sqrtRatioNextX96;
    amountRemaining -= step.amountIn + step.feeAmount;
    amountCalculated += step.amountOut;

    // Check if we crossed a tick boundary
    if (sqrtPriceX96 === sqrtPriceNextTickX96 && nextTick !== null) {
      // Cross the tick — adjust liquidity
      const tickData = asTickData(ticks?.get(nextTick));
      if (tickData) {
        // OPTIMIZATION: Assume internal state is already BigInt or cast once
        const liquidityNetRaw = tickData.liquidityNet;
        const liquidityNet = typeof liquidityNetRaw === "bigint" ? liquidityNetRaw : toBigIntOrNull(liquidityNetRaw);

        if (liquidityNet == null) break;
        // When moving left (zeroForOne), we subtract liquidityNet
        // When moving right (!zeroForOne), we add liquidityNet
        liquidity = zeroForOne ? liquidity - liquidityNet : liquidity + liquidityNet;
        ticksCrossed++;
      } else {
        // If we crossed an initialized boundary and have no tick data,
        // we must assume liquidity drops to 0 to prevent infinite liquidity exploit.
        if (!hasTicks) {
          maxReliableAmountIn = amountIn - amountRemaining;
        }
        liquidity = 0n;
      }

      // Update tick position
      tick = zeroForOne ? nextTick - 1 : nextTick;
    } else {
      // Didn't reach the next initialized boundary, so derive the active tick
      // from the post-swap sqrt price to keep downstream metadata canonical.
      // We already know the active tick must lie within the interval bounded by
      // the previous active tick and the next initialized boundary when present.
      const minTick = zeroForOne ? (nextTick ?? MIN_TICK) : tick;
      const maxTick = zeroForOne ? tick : nextTick != null ? nextTick - 1 : MAX_TICK;
      tick = getTickAtSqrtRatioInRange(sqrtPriceX96, minTick, maxTick);
      break;
    }

    // Safety: if liquidity drops to zero, we can't continue
    if (liquidity <= 0n) {
      if (hasTicks && amountRemaining > 0n) {
        tickDataExhausted = true;
        maxReliableAmountIn = amountIn - amountRemaining;
      }
      break;
    }
  }

  // Gas estimate: ~185k base (Polygon V3 measured) + ~25k per tick crossed.
  // Previous value of 130k base understated cost by ~40–50k, inflating net profit projections.
  const gasEstimate = 185_000 + ticksCrossed * 25_000;

  let amountOut = amountCalculated;
  if (zeroForOne) {
    const bal1 = pool.token1Balance;
    if (typeof bal1 === "bigint" && amountOut > bal1) {
      amountOut = bal1;
    }
  } else {
    const bal0 = pool.token0Balance;
    if (typeof bal0 === "bigint" && amountOut > bal0) {
      amountOut = bal0;
    }
  }

  return {
    amountOut,
    sqrtPriceX96After: sqrtPriceX96,
    tickAfter: tick,
    gasEstimate,
    shallow: !hasTicks || tickDataExhausted,
    maxReliableAmountIn: hasTicks && !tickDataExhausted ? amountIn : maxReliableAmountIn,
  };
}

/**
 * Estimate max input that stays within one tick-spacing move (shallow V3 guard).
 */
export function estimateSingleTickSpacingCapacity(state: unknown, zeroForOne: boolean): bigint {
  const pool = asPoolState(state);
  const liq = toBigIntOrNull(pool.liquidity);
  const sqrtPrice = toBigIntOrNull(pool.sqrtPriceX96);
  if (liq == null || liq <= 0n || sqrtPrice == null || sqrtPrice <= 0n) return 0n;

  const tick = Number.isInteger(pool.tick) ? Number(pool.tick) : 0;
  const tickSpacing = Number.isFinite(Number(pool.tickSpacing)) ? Number(pool.tickSpacing) : 60;
  const nextTick = zeroForOne ? tick - tickSpacing : tick + tickSpacing;
  const sqrtNext = getSqrtRatioAtTick(nextTick);
  const feePips = toBigIntOrNull(pool.fee) ?? 3000n;

  const step = computeSwapStep(sqrtPrice, sqrtNext, liq, 2n ** 256n - 1n, feePips);
  return step.amountIn + step.feeAmount;
}

/**
 * Quote a V3 swap: given amountIn of one token, how much of the other do you get?
 *
 * @param {Object} state      Pool state snapshot
 * @param {bigint} amountIn   Input amount
 * @param {boolean} zeroForOne Direction
 * @param {number} [fee]      Optional fee tier override
 * @returns {bigint}          Output amount
 */
export function quoteV3(state: unknown, amountIn: bigint, zeroForOne: boolean, fee?: number) {
  return simulateV3Swap(state, amountIn, zeroForOne, fee).amountOut;
}

/** Clear sorted-ticks LRU cache (vitest isolation). */
export function resetV3SimCacheForTests(): void {
  sortedTicksCache.clear();
}
