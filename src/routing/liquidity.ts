import { toBigIntOrNull } from "../utils/bigint.ts";
import {
  BALANCER_PROTOCOLS,
  CURVE_PROTOCOLS,
  DODO_PROTOCOLS,
  normalizeProtocolKey,
  V2_PROTOCOLS,
  V3_PROTOCOLS,
  WOOFI_PROTOCOLS,
} from "../protocols/classification.ts";
import type { SwapEdge } from "./graph.ts";
import type { RouteState } from "./simulation_types.ts";

type RateFn = (token: string) => bigint;
type LiquidityEdge = Pick<SwapEdge, "protocol" | "tokenIn" | "tokenOut" | "zeroForOne"> & {
  stateRef?: SwapEdge["stateRef"];
};
type TokenPair = readonly [unknown, unknown];

function rateFor(getRateWei: RateFn, token: unknown) {
  if (typeof token !== "string" || token.length === 0) return 0n;
  try {
    return getRateWei(token.toLowerCase());
  } catch {
    return 0n;
  }
}

function valueTokenAmount(amount: unknown, token: unknown, getRateWei: RateFn) {
  const rawAmount = toBigIntOrNull(amount);
  const rate = rateFor(getRateWei, token);
  return rawAmount != null && rawAmount > 0n && rate > 0n ? rawAmount * rate : 0n;
}

function tokensFromStateOrEdge(edge: LiquidityEdge, state: RouteState): TokenPair {
  if (Array.isArray(state?.tokens) && state.tokens.length >= 2) {
    return [state.tokens[0], state.tokens[1]];
  }
  const token0 = edge.zeroForOne ? edge.tokenIn : edge.tokenOut;
  const token1 = edge.zeroForOne ? edge.tokenOut : edge.tokenIn;
  return [token0, token1];
}

function balancesLiquidityWmatic(state: RouteState, getRateWei: RateFn) {
  if (!Array.isArray(state?.balances) || !Array.isArray(state?.tokens)) return 0n;
  const count = Math.min(state.balances.length, state.tokens.length);
  let total = 0n;
  for (let index = 0; index < count; index++) {
    total += valueTokenAmount(state.balances[index], state.tokens[index], getRateWei);
  }
  return total;
}

function v2LiquidityWmatic(edge: LiquidityEdge, state: RouteState, getRateWei: RateFn) {
  const [token0, token1] = tokensFromStateOrEdge(edge, state);
  return (
    valueTokenAmount(state.reserve0, token0, getRateWei) +
    valueTokenAmount(state.reserve1, token1, getRateWei)
  );
}

function v3LiquidityWmatic(edge: LiquidityEdge, state: RouteState, getRateWei: RateFn) {
  if (!state?.initialized || !state.sqrtPriceX96 || !state.liquidity) return 0n;
  const sqrtPriceX96 = toBigIntOrNull(state.sqrtPriceX96);
  const liquidity = toBigIntOrNull(state.liquidity);
  if (sqrtPriceX96 == null || liquidity == null || sqrtPriceX96 <= 0n || liquidity <= 0n) return 0n;
  const [token0, token1] = tokensFromStateOrEdge(edge, state);
  const virtualReserve0 = (liquidity << 96n) / sqrtPriceX96;
  const virtualReserve1 = (liquidity * sqrtPriceX96) >> 96n;
  return (
    valueTokenAmount(virtualReserve0, token0, getRateWei) +
    valueTokenAmount(virtualReserve1, token1, getRateWei)
  );
}

function dodoLiquidityWmatic(state: RouteState, getRateWei: RateFn) {
  const tokens = Array.isArray(state?.tokens) ? state.tokens : [];
  return (
    valueTokenAmount(state?.baseReserve, state?.baseToken ?? tokens[0], getRateWei) +
    valueTokenAmount(state?.quoteReserve, state?.quoteToken ?? tokens[1], getRateWei)
  );
}

export function poolLiquidityWmatic(edge: LiquidityEdge | null | undefined, getRateWei: RateFn | null | undefined) {
  if (!getRateWei) return 0n;
  const state = edge?.stateRef;
  if (!state) return 0n;
  const protocol = normalizeProtocolKey(edge.protocol ?? state.protocol);

  if (V2_PROTOCOLS.has(protocol)) return v2LiquidityWmatic(edge, state, getRateWei);
  if (V3_PROTOCOLS().has(protocol)) return v3LiquidityWmatic(edge, state, getRateWei);
  if (CURVE_PROTOCOLS.has(protocol) || BALANCER_PROTOCOLS.has(protocol) || WOOFI_PROTOCOLS.has(protocol)) {
    return balancesLiquidityWmatic(state, getRateWei);
  }
  if (DODO_PROTOCOLS.has(protocol)) return dodoLiquidityWmatic(state, getRateWei);

  return 0n;
}
