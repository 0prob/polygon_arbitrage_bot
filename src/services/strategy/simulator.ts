import type { PoolState } from "../../core/types/pool.ts";
import type { SimulatedHopResult, RouteSimulationResult, RouteStateCache } from "../../core/types/route.ts";
import { simulateV2Swap } from "../../core/math/uniswap_v2.ts";
import { simulateV3Swap } from "../../core/math/uniswap_v3.ts";
import { simulateCurveSwap } from "../../core/math/curve.ts";
import { simulateBalancerSwap } from "../../core/math/balancer.ts";
import { simulateDodoSwap } from "../../core/math/dodo.ts";
import { simulateWoofiSwap } from "../../core/math/woofi.ts";
import type { SwapEdge } from "./graph.ts";

export interface SimulationEdge {
  poolAddress: string;
  tokenIn: string;
  tokenOut: string;
  protocol: string;
  zeroForOne: boolean;
  fee?: number | bigint | string | null;
  swapFeeBps?: number | null;
  tokenInIdx?: number;
  tokenOutIdx?: number;
  stateRef?: PoolState | null;
}

/** Normalize protocol string to a canonical name for dispatch. */
function normalizeProtocol(raw: string): string {
  const u = raw.toUpperCase();
  // Known aliases that don't contain V2/V3 in their canonical name
  if (u.startsWith("CURVE")) return "CURVE";
  if (u.startsWith("BALANCER")) return "BALANCER";
  if (u.startsWith("DODO")) return "DODO";
  if (u.startsWith("WOOFI")) return "WOOFI";
  // Everything else falls through to V2/V3 matching
  if (u.includes("V3") || u === "KYBERSWAP_ELASTIC" || u === "UNISWAP_V4") return "V3";
  if (u.includes("V2")) return "V2";
  return u;
}

function inferZeroForOne(edge: { tokenIn: string; tokenOut: string }, state: Record<string, unknown>): boolean {
  const t0 = state.token0;
  if (typeof t0 === "string") return edge.tokenIn.toLowerCase() === t0.toLowerCase();
  if (Array.isArray(state.tokens)) {
    const tokens = state.tokens as string[];
    const tokenIn = edge.tokenIn.toLowerCase();
    return tokens.some((t) => t.toLowerCase() === tokenIn);
  }
  return edge.tokenIn.toLowerCase() < edge.tokenOut.toLowerCase();
}

function inferTokenIdx(token: string, state: Record<string, unknown>, fallback: number): number {
  const tokens = state.tokens;
  if (Array.isArray(tokens)) {
    const addr = token.toLowerCase();
    const idx = tokens.findIndex((t: unknown) => typeof t === "string" && t.toLowerCase() === addr);
    if (idx >= 0) return idx;
  }
  return fallback;
}

/** Dispatch a single hop simulation to the correct math module. */
export function simulateHop(edge: SimulationEdge, amountIn: bigint, stateCache: RouteStateCache): SimulatedHopResult {
  const state = stateCache.get(edge.poolAddress.toLowerCase()) ?? edge.stateRef;
  if (!state) throw new Error(`No state for pool ${edge.poolAddress}`);

  switch (normalizeProtocol(edge.protocol)) {
    case "V2":
      return simulateV2Swap(state, amountIn, edge.zeroForOne);
    case "V3":
      return extractGasResult(simulateV3Swap(state, amountIn, edge.zeroForOne));
    case "CURVE":
      return simulateCurveSwap(amountIn, state, edge.tokenInIdx ?? 0, edge.tokenOutIdx ?? 1);
    case "BALANCER":
      return simulateBalancerSwap(amountIn, state, edge.tokenInIdx ?? 0, edge.tokenOutIdx ?? 1);
    case "DODO":
      return simulateDodoSwap(state, amountIn, edge.zeroForOne);
    case "WOOFI":
      return simulateWoofiSwap(amountIn, state, edge.tokenInIdx ?? 0, edge.tokenOutIdx ?? 1);
    default:
      throw new Error(`Unknown protocol: ${edge.protocol}`);
  }
}

function extractGasResult(r: { amountOut: bigint; gasEstimate: number }): SimulatedHopResult {
  return { amountOut: r.amountOut, gasEstimate: r.gasEstimate };
}

/** Simulate a full multi-hop route. Direction is inferred from stateRef. */
export function simulateRoute(edges: SwapEdge[], amountIn: bigint, stateCache: RouteStateCache): RouteSimulationResult {
  const hopAmounts: bigint[] = [amountIn];
  let totalGas = 0;
  const poolPath: string[] = [];
  const tokenPath: string[] = [];
  const protocols: string[] = [];

  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    const state = (stateCache.get(edge.poolAddress.toLowerCase()) ?? edge.stateRef) as Record<string, unknown> | undefined;
    if (!state) throw new Error(`No state for pool ${edge.poolAddress}`);

    const simEdge: SimulationEdge = {
      poolAddress: edge.poolAddress,
      tokenIn: edge.tokenIn,
      tokenOut: edge.tokenOut,
      protocol: edge.protocol,
      zeroForOne: edge.zeroForOne ?? inferZeroForOne(edge, state),
      tokenInIdx: edge.tokenInIdx ?? inferTokenIdx(edge.tokenIn, state, 0),
      tokenOutIdx: edge.tokenOutIdx ?? inferTokenIdx(edge.tokenOut, state, 1),
      stateRef: state as PoolState,
    };

    const hop = simulateHop(simEdge, hopAmounts[i], stateCache);
    hopAmounts.push(hop.amountOut);
    totalGas += hop.gasEstimate;
    poolPath.push(edge.poolAddress);
    tokenPath.push(edge.tokenIn);
    protocols.push(edge.protocol);
  }

  const amountOut = hopAmounts[hopAmounts.length - 1];
  const profit = amountOut - amountIn;

  return {
    amountIn,
    amountOut,
    profit,
    profitable: profit > 0n,
    hopAmounts,
    totalGas,
    poolPath,
    tokenPath: [...tokenPath, edges[edges.length - 1]?.tokenOut ?? ""],
    protocols,
    hopCount: edges.length,
  };
}
