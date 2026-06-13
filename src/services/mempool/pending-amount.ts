import type { PoolState } from "../../core/types/pool.ts";
import { getV2AmountIn, resolveV2Fee, simulateV2Swap } from "../../core/math/uniswap_v2.ts";
import { normalizeProtocol } from "../../core/utils/protocol.ts";
import type { DecodedSwap } from "./decoder.ts";

/**
 * Resolve the effective swap input amount for pending-state projection.
 * V2 pool.swap() calldata carries output amounts; V3 negative amountSpecified is exact-output.
 */
export function resolveSwapAmountIn(decoded: DecodedSwap, currentState?: PoolState): bigint {
  const proto = normalizeProtocol(decoded.protocol);

  if (proto === "V2") {
    const amountOut = decoded.amountIn;
    const isZFO = decoded.zeroForOne ?? true;
    if (currentState?.reserve0 != null && currentState?.reserve1 != null) {
      const r0 = BigInt(currentState.reserve0);
      const r1 = BigInt(currentState.reserve1);
      if (r0 > 0n && r1 > 0n) {
        const resolved = isZFO ? getV2AmountIn(amountOut, r0, r1) : getV2AmountIn(amountOut, r1, r0);
        if (resolved > 0n) return resolved;
      }
    }
    return amountOut;
  }

  // V3/V4: decoded.amountIn is |amountSpecified|; positive = exact input (correct).
  return decoded.amountIn;
}

/** Reserve deltas for overlay fallback when override store build fails. */
export function computeV2OverlayDeltas(
  decoded: DecodedSwap,
  currentState?: PoolState,
): { reserve0?: bigint; reserve1?: bigint } | null {
  if (normalizeProtocol(decoded.protocol) !== "V2") return null;

  const amountIn = resolveSwapAmountIn(decoded, currentState);
  const isZFO = decoded.zeroForOne ?? true;

  if (currentState?.reserve0 != null && currentState?.reserve1 != null) {
    const { numerator, denominator } = resolveV2Fee(currentState, undefined, 1000n);
    const swap = simulateV2Swap(currentState, amountIn, isZFO, numerator, denominator);
    if (swap.amountOut > 0n) {
      return isZFO
        ? { reserve0: amountIn, reserve1: -swap.amountOut }
        : { reserve1: amountIn, reserve0: -swap.amountOut };
    }
  }

  return isZFO ? { reserve0: amountIn } : { reserve1: amountIn };
}
