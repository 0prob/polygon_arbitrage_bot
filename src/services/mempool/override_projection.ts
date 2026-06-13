import type { PoolState } from "../../core/types/pool.ts";
import type { StateOverride } from "../../core/types/state-override.ts";
import type { PendingOverrideStore } from "./pending-override.ts";

const V2_RESERVE0_SLOT = "0x0000000000000000000000000000000000000000000000000000000000000008";
const V2_RESERVE1_SLOT = "0x0000000000000000000000000000000000000000000000000000000000000009";
const V3_SLOT0_SLOT = "0x0000000000000000000000000000000000000000000000000000000000000000";
const V3_LIQUIDITY_SLOT = "0x0000000000000000000000000000000000000000000000000000000000000001";

function slotToBigInt(hex: string): bigint {
  return BigInt(hex);
}

/** Apply Geth stateDiff entries onto a pool snapshot for simulation. */
export function applyOverrideToPoolState(
  base: PoolState,
  override: StateOverride,
  poolAddress: string,
): PoolState {
  const entry = override[poolAddress.toLowerCase() as `0x${string}`] ?? override[poolAddress as `0x${string}`];
  if (!entry?.stateDiff) return base;

  const projected: PoolState = { ...base };
  const diff = entry.stateDiff;

  if (diff[V2_RESERVE0_SLOT]) {
    projected.reserve0 = slotToBigInt(diff[V2_RESERVE0_SLOT]);
  }
  if (diff[V2_RESERVE1_SLOT]) {
    projected.reserve1 = slotToBigInt(diff[V2_RESERVE1_SLOT]);
  }
  if (diff[V3_SLOT0_SLOT]) {
    const packed = slotToBigInt(diff[V3_SLOT0_SLOT]);
    projected.sqrtPriceX96 = packed & ((1n << 160n) - 1n);
    const tickRaw = Number((packed >> 160n) & ((1n << 24n) - 1n));
    projected.tick = tickRaw >= 0x800000 ? tickRaw - 0x1000000 : tickRaw;
  }
  if (diff[V3_LIQUIDITY_SLOT]) {
    projected.liquidity = slotToBigInt(diff[V3_LIQUIDITY_SLOT]);
  }

  return projected;
}

export function getProjectedPoolState(
  poolAddress: string,
  baseState: PoolState,
  overlay?: { getProjected(pool: string, base: PoolState): PoolState | undefined },
  overrideStore?: PendingOverrideStore,
): PoolState {
  let state = baseState;
  if (overlay) {
    const overlaid = overlay.getProjected(poolAddress, baseState);
    if (overlaid) state = overlaid;
  }
  if (overrideStore?.hasActive() && overrideStore.isAffected(poolAddress as `0x${string}`)) {
    const merged = overrideStore.get();
    if (merged) {
      state = applyOverrideToPoolState(state, merged, poolAddress.toLowerCase());
    }
  }
  return state;
}
