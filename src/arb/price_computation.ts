import { toBigIntOrNull } from "../utils/bigint.ts";
import type { RouteState } from "../routing/simulation_types.ts";
import { simulateV2Swap } from "../math/uniswap_v2.ts";
import { simulateV3Swap } from "../math/uniswap_v3.ts";

/**
 * src/arb/price_computation.ts
 *
 * All prices are computed as bigint fractions with 18 decimals of precision.
 */

export const Q128 = 2n ** 128n;
export const Q192 = 2n ** 192n;
export const PRICE_SCALE = 10n ** 18n;

export function computePrice(state: Record<string, unknown>, tokenInIsToken0: boolean): bigint {
  const reserve0 = toBigIntOrNull(state.reserve0);
  const reserve1 = toBigIntOrNull(state.reserve1);
  if (reserve0 == null || reserve1 == null || reserve0 === 0n || reserve1 === 0n) return 0n;

  if (tokenInIsToken0) {
    return (reserve1 * 10n ** 18n) / reserve0;
  } else {
    return (reserve0 * 10n ** 18n) / reserve1;
  }
}

export function computeSqrtPrice(state: Record<string, unknown>): bigint {
  const sqrtPriceX96 = toBigIntOrNull(state.sqrtPriceX96);
  return sqrtPriceX96 ?? 0n;
}

export function computeFee(state: Record<string, unknown>): { numerator: bigint; denominator: bigint } {
  const feeNumerator = toBigIntOrNull(state.fee) ?? 997n;
  const feeDenominator = toBigIntOrNull(state.feeDenominator) ?? 1000n;
  return { numerator: feeNumerator, denominator: feeDenominator };
}

export function hasSqrtPrice(state: Record<string, unknown>): boolean {
  return toBigIntOrNull(state.sqrtPriceX96) != null;
}

function numberOrUndefined(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : undefined;
  }
  return undefined;
}

export function computeSpotPriceScaled(state: RouteState, zeroForOne: boolean) {
  const reserve0 = toBigIntOrNull(state.reserve0);
  const reserve1 = toBigIntOrNull(state.reserve1);
  if (reserve0 != null && reserve1 != null) {
    const reserveIn = zeroForOne ? reserve0 : reserve1;
    const reserveOut = zeroForOne ? reserve1 : reserve0;
    if (reserveIn <= 0n || reserveOut <= 0n) return 0n;
    return (reserveOut * PRICE_SCALE) / reserveIn;
  }

  const sqrtPriceX96 = toBigIntOrNull(state.sqrtPriceX96);
  if (sqrtPriceX96 == null || sqrtPriceX96 <= 0n) return 0n;
  const priceX192 = sqrtPriceX96 * sqrtPriceX96;
  return zeroForOne
    ? (priceX192 * PRICE_SCALE) / Q192
    : (Q192 * PRICE_SCALE) / priceX192;
}

export function computeVirtualAmountOutAfterFees(
  state: RouteState,
  amountIn: bigint,
  zeroForOne: boolean,
  fee?: number,
) {
  if (amountIn <= 0n) return 0n;
  const reserve0 = toBigIntOrNull(state.reserve0);
  const reserve1 = toBigIntOrNull(state.reserve1);
  if (reserve0 != null && reserve1 != null) {
    const feeNumerator = toBigIntOrNull(state.fee) ?? 997n;
    const feeDenominator = toBigIntOrNull(state.feeDenominator) ?? 1000n;
    return simulateV2Swap(state, amountIn, zeroForOne, feeNumerator, feeDenominator).amountOut;
  }

  if (toBigIntOrNull(state.sqrtPriceX96) != null) {
    return simulateV3Swap(state, amountIn, zeroForOne, fee ?? numberOrUndefined(state.fee)).amountOut;
  }

  return 0n;
}

export function computeVirtualPriceAfterFeesScaled(
  state: RouteState,
  amountIn: bigint,
  zeroForOne: boolean,
  fee?: number,
) {
  if (amountIn <= 0n) return 0n;
  const amountOut = computeVirtualAmountOutAfterFees(state, amountIn, zeroForOne, fee);
  if (amountOut <= 0n) return 0n;
  return (amountOut * PRICE_SCALE) / amountIn;
}

export function computeSlippageBps(
  spotPriceScaled: bigint,
  virtualPriceAfterFeesScaled: bigint,
) {
  if (spotPriceScaled <= 0n || virtualPriceAfterFeesScaled >= spotPriceScaled) return 0n;
  return ((spotPriceScaled - virtualPriceAfterFeesScaled) * 10_000n) / spotPriceScaled;
}

export function computeGasAdjustedProfit(
  grossProfitRaw: bigint,
  gasUnits: bigint | number,
  gasPriceWei: bigint,
  tokenToMaticRate: bigint,
) {
  const gas = typeof gasUnits === "bigint" ? gasUnits : BigInt(Math.max(0, Math.floor(gasUnits)));
  if (tokenToMaticRate <= 0n || gasPriceWei <= 0n) {
    return {
      gasCostRaw: 0n,
      netProfitRaw: grossProfitRaw,
    };
  }
  const gasCostWei = gas * gasPriceWei;
  // Fix #8: use ceiling division so that any non-zero gas cost always deducts
  // at least 1 raw token unit. Floor division rounds to 0 for high-value tokens
  // (WETH, WBTC) where tokenToMaticRate is large relative to gasCostWei,
  // making net profit appear equal to gross profit.
  const gasCostRaw = (gasCostWei + tokenToMaticRate - 1n) / tokenToMaticRate;
  return {
    gasCostRaw,
    netProfitRaw: grossProfitRaw - gasCostRaw,
  };
}

export function computePoolPriceQuote(input: {
  state: RouteState;
  amountIn: bigint;
  zeroForOne: boolean;
  grossProfitRaw?: bigint;
  gasUnits?: bigint | number;
  gasPriceWei?: bigint;
  tokenToMaticRate?: bigint;
  fee?: number;
}) {
  const spotPriceScaled = computeSpotPriceScaled(input.state, input.zeroForOne);
  const virtualPriceAfterFeesScaled = computeVirtualPriceAfterFeesScaled(
    input.state,
    input.amountIn,
    input.zeroForOne,
    input.fee,
  );
  const slippageBps = computeSlippageBps(spotPriceScaled, virtualPriceAfterFeesScaled);
  const gasAdjusted = computeGasAdjustedProfit(
    input.grossProfitRaw ?? 0n,
    input.gasUnits ?? 0n,
    input.gasPriceWei ?? 0n,
    input.tokenToMaticRate ?? 0n,
  );
  return {
    spotPriceScaled,
    virtualPriceAfterFeesScaled,
    slippageBps,
    ...gasAdjusted,
  };
}
