import { normalizeAddress } from "../utils/identity.ts";
import type { RouteState } from "./simulation_types.ts";

type SwapIndexEdge = {
  tokenIn?: unknown;
  tokenOut?: unknown;
  tokenInIdx?: unknown;
  tokenOutIdx?: unknown;
  zeroForOne?: boolean;
};

export type SwapTokenIndexes = {
  tokenInIdx: number;
  tokenOutIdx: number;
};

export function resolveSwapTokenIndexes(edge: SwapIndexEdge, state: RouteState | null | undefined): SwapTokenIndexes | null {
  const explicitIn = Number(edge?.tokenInIdx);
  const explicitOut = Number(edge?.tokenOutIdx);
  if (Number.isInteger(explicitIn) && explicitIn >= 0 && Number.isInteger(explicitOut) && explicitOut >= 0 && explicitIn !== explicitOut) {
    return { tokenInIdx: explicitIn, tokenOutIdx: explicitOut };
  }

  const tokens = Array.isArray(state?.tokens) ? state.tokens.map((t) => normalizeAddress(t)) : [];
  const tokenIn = normalizeAddress(edge?.tokenIn);
  const tokenOut = normalizeAddress(edge?.tokenOut);

  if (tokens.length > 0 && tokenIn && tokenOut) {
    const tokenInIdx = tokens.indexOf(tokenIn);
    const tokenOutIdx = tokens.indexOf(tokenOut);
    if (tokenInIdx >= 0 && tokenOutIdx >= 0 && tokenInIdx !== tokenOutIdx) {
      return { tokenInIdx, tokenOutIdx };
    }
  }

  if (tokens.length === 2) {
    return edge?.zeroForOne ? { tokenInIdx: 0, tokenOutIdx: 1 } : { tokenInIdx: 1, tokenOutIdx: 0 };
  }

  return null;
}
