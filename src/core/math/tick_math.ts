/**
 * src/math/tick_math.js — Tick ↔ sqrtPriceX96 conversions
 *
 * JavaScript BigInt port of Uniswap V3's TickMath.sol.
 * Uses the same 20 magic constants for binary decomposition.
 *
 * All prices are Q64.96 fixed-point (BigInt).
 */

// ─── Constants ────────────────────────────────────────────────

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_SQRT_RATIO = 4295128739n;
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

const MAX_UINT256 = 115792089237316195423570985008687907853269984665640564039457584007913129639935n;
const SHIFT_32 = 1n << 32n;

// ─── getSqrtRatioAtTick ───────────────────────────────────────

/**
 * Calculates sqrt(1.0001^tick) * 2^96.
 *
 * Direct port of TickMath.getSqrtRatioAtTick from Solidity.
 * Uses the 20 precomputed magic constants for binary decomposition.
 *
 * @param {number} tick  Integer tick value, must satisfy |tick| <= MAX_TICK
 * @returns {bigint}     sqrtPriceX96 as Q64.96 BigInt
 */
export function getSqrtRatioAtTick(tick: number): bigint {
  if (tick < MIN_TICK || tick > MAX_TICK) {
    throw new Error(`TickMath: tick ${tick} out of range [${MIN_TICK}, ${MAX_TICK}]`);
  }

  const absTick = BigInt(tick < 0 ? -tick : tick);

  let ratio = (absTick & 0x1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;

  if ((absTick & 0x2n) !== 0n) ratio = (ratio * 0xfff97272373d413259a46990580e213an) >> 128n;
  if ((absTick & 0x4n) !== 0n) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n;
  if ((absTick & 0x8n) !== 0n) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0n) >> 128n;
  if ((absTick & 0x10n) !== 0n) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644n) >> 128n;
  if ((absTick & 0x20n) !== 0n) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0n) >> 128n;
  if ((absTick & 0x40n) !== 0n) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861n) >> 128n;
  if ((absTick & 0x80n) !== 0n) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053n) >> 128n;
  if ((absTick & 0x100n) !== 0n) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4n) >> 128n;
  if ((absTick & 0x200n) !== 0n) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54n) >> 128n;
  if ((absTick & 0x400n) !== 0n) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3n) >> 128n;
  if ((absTick & 0x800n) !== 0n) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9n) >> 128n;
  if ((absTick & 0x1000n) !== 0n) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825n) >> 128n;
  if ((absTick & 0x2000n) !== 0n) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5n) >> 128n;
  if ((absTick & 0x4000n) !== 0n) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7n) >> 128n;
  if ((absTick & 0x8000n) !== 0n) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6n) >> 128n;
  if ((absTick & 0x10000n) !== 0n) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9n) >> 128n;
  if ((absTick & 0x20000n) !== 0n) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604n) >> 128n;
  if ((absTick & 0x40000n) !== 0n) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98n) >> 128n;
  if ((absTick & 0x80000n) !== 0n) ratio = (ratio * 0x48a170391f7dc42444e8fa2n) >> 128n;

  if (tick > 0) ratio = MAX_UINT256 / ratio;

  // Shift from Q128.128 to Q128.96, rounding up
  const shifted = ratio >> 32n;
  const sqrtPriceX96 = ratio % SHIFT_32 === 0n ? shifted : shifted + 1n;

  return sqrtPriceX96;
}

export function normaliseTickSearchBounds(minTick: number, maxTick: number) {
  const lo = Math.max(MIN_TICK, Math.min(minTick, maxTick));
  const hi = Math.min(MAX_TICK, Math.max(minTick, maxTick));
  if (lo > hi) {
    throw new Error(`TickMath: invalid tick search bounds [${minTick}, ${maxTick}]`);
  }
  return { lo, hi };
}

// ─── getTickAtSqrtRatio ───────────────────────────────────────

/**
 * Calculates the greatest tick value such that getSqrtRatioAtTick(tick) <= sqrtPriceX96.
 *
 * Uses a binary search approach for simplicity and correctness.
 *
 * @param {bigint} sqrtPriceX96  Q64.96 sqrt price
 * @returns {number}             The tick
 */
export function getTickAtSqrtRatio(sqrtPriceX96: bigint): number {
  if (sqrtPriceX96 < MIN_SQRT_RATIO || sqrtPriceX96 >= MAX_SQRT_RATIO) {
    throw new Error(`TickMath: sqrtPriceX96 ${sqrtPriceX96} out of range [${MIN_SQRT_RATIO}, ${MAX_SQRT_RATIO})`);
  }

  const ratio = sqrtPriceX96 << 32n;

  let r = ratio;
  let msb = 0n;

  if (r >= 0x100000000000000000000000000000000n) {
    r >>= 128n;
    msb += 128n;
  }
  if (r >= 0x10000000000000000n) {
    r >>= 64n;
    msb += 64n;
  }
  if (r >= 0x100000000n) {
    r >>= 32n;
    msb += 32n;
  }
  if (r >= 0x10000n) {
    r >>= 16n;
    msb += 16n;
  }
  if (r >= 0x100n) {
    r >>= 8n;
    msb += 8n;
  }
  if (r >= 0x10n) {
    r >>= 4n;
    msb += 4n;
  }
  if (r >= 0x4n) {
    r >>= 2n;
    msb += 2n;
  }
  if (r >= 0x2n) {
    msb += 1n;
  }

  if (msb >= 128n) {
    r = ratio >> (msb - 127n);
  } else {
    r = ratio << (127n - msb);
  }

  let log_2 = (msb - 128n) << 64n;

  for (let i = 0n; i < 14n; i++) {
    r = (r * r) >> 127n;
    const f = r >> 128n;
    log_2 = log_2 | (f << (63n - i));
    r >>= f;
  }

  const log_sqrt10001 = log_2 * 255738958999603826347141n;

  // Uniswap V3 exact constants
  const tickLow = Number((log_sqrt10001 - 3402992956809132418596140100660247210n) >> 128n);
  const tickHigh = Number((log_sqrt10001 + 291339464771989622907027621153398088495n) >> 128n);

  return tickLow === tickHigh ? tickLow : getSqrtRatioAtTick(tickHigh) <= sqrtPriceX96 ? tickHigh : tickLow;
}

/**
 * Calculates the greatest tick within a bounded range such that
 * getSqrtRatioAtTick(tick) <= sqrtPriceX96.
 *
 * Useful when callers already know the active price interval, which avoids a
 * full-range binary search over the entire TickMath domain.
 *
 * @param {bigint} sqrtPriceX96  Q64.96 sqrt price
 * @param {number} minTick       Inclusive lower search bound
 * @param {number} maxTick       Inclusive upper search bound
 * @returns {number}             The tick
 */
export function getTickAtSqrtRatioInRange(sqrtPriceX96: bigint, minTick: number, maxTick: number): number {
  if (sqrtPriceX96 < MIN_SQRT_RATIO || sqrtPriceX96 >= MAX_SQRT_RATIO) {
    throw new Error(`TickMath: sqrtPriceX96 ${sqrtPriceX96} out of range [${MIN_SQRT_RATIO}, ${MAX_SQRT_RATIO})`);
  }

  const tick = getTickAtSqrtRatio(sqrtPriceX96);
  return tick < minTick ? minTick : tick > maxTick ? maxTick : tick;
}
