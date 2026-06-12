/**
 * Uniswap V4 concentrated-liquidity swap simulation.
 *
 * V4 uses the same core swap math as V3 inside PoolManager-managed pools.
 * This module adds V4-specific validation (hooks, tickSpacing, dynamic fee)
 * and gas overhead for the lock/unlock execution path.
 */

import { simulateV3Swap } from "./uniswap_v3.ts";
import { toBigIntOrNull } from "../utils/bigint.ts";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
/** Extra gas vs a direct V3 pool swap (PoolManager.lock + settle). */
const V4_LOCK_GAS_OVERHEAD = 85_000;

export type V4SimRejectReason = "hooks" | "invalid_state" | "zero_liquidity";

export interface V4SwapResult {
  amountOut: bigint;
  sqrtPriceX96After: bigint;
  tickAfter: number;
  gasEstimate: number;
  rejectedReason?: V4SimRejectReason;
}

function asPoolRecord(state: unknown): Record<string, unknown> {
  return state != null && typeof state === "object" ? (state as Record<string, unknown>) : {};
}

function normalizeHooks(hooks: unknown): string {
  if (typeof hooks !== "string" || hooks.length === 0) return ZERO_ADDRESS;
  return hooks.toLowerCase();
}

/**
 * Simulate an exact-input swap on a Uniswap V4 pool state snapshot.
 *
 * Pools with non-zero hooks are rejected — hook contracts can alter swap math
 * and cannot be modeled generically off-chain.
 */
export function simulateV4Swap(
  state: unknown,
  amountIn: bigint,
  zeroForOne: boolean,
  feeOverride?: number,
): V4SwapResult {
  const pool = asPoolRecord(state);
  const hooks = normalizeHooks(pool.hooks);
  if (hooks !== ZERO_ADDRESS) {
    return {
      amountOut: 0n,
      sqrtPriceX96After: 0n,
      tickAfter: 0,
      gasEstimate: 0,
      rejectedReason: "hooks",
    };
  }

  const liquidity = toBigIntOrNull(pool.liquidity);
  const sqrtPrice = toBigIntOrNull(pool.sqrtPriceX96);
  if (liquidity == null || liquidity <= 0n || sqrtPrice == null || sqrtPrice <= 0n) {
    return {
      amountOut: 0n,
      sqrtPriceX96After: sqrtPrice ?? 0n,
      tickAfter: Number.isInteger(pool.tick) ? Number(pool.tick) : 0,
      gasEstimate: 0,
      rejectedReason: "zero_liquidity",
    };
  }

  const tickSpacing = Number(pool.tickSpacing ?? 60);
  const tickStep = Math.max(1, Number.isFinite(tickSpacing) ? tickSpacing * 2 : 120);

  const feePips =
    feeOverride ??
    (pool.fee != null ? Number(toBigIntOrNull(pool.fee) ?? 0n) : undefined);

  const enriched = {
    ...pool,
    initialized: pool.initialized ?? true,
    poolId: pool.poolId ?? pool.address,
    tickStepOverride: tickStep,
  };

  const result = simulateV3Swap(enriched, amountIn, zeroForOne, feePips);

  if (result.amountOut <= 0n) {
    return {
      ...result,
      gasEstimate: result.gasEstimate,
      rejectedReason: "invalid_state",
    };
  }

  return {
    ...result,
    gasEstimate: result.gasEstimate + V4_LOCK_GAS_OVERHEAD,
  };
}

/** @internal test helper */
export function resetV4SimCacheForTests(): void {
  /* V4 delegates to V3 tick cache — cleared via resetV3SimCacheForTests */
}
