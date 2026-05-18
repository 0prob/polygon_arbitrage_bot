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

function inferZeroForOne(edge: SwapEdge, state: Record<string, unknown>): boolean {
  const t0 = state.token0;
  if (typeof t0 === "string" && edge.tokenIn.toLowerCase() === t0.toLowerCase()) return true;
  if (typeof t0 === "string") return false;
  return true;
}

function inferTokenIdx(edge: SwapEdge, needle: "tokenIn" | "tokenOut", state: Record<string, unknown>): number {
  const tokens = state.tokens;
  if (Array.isArray(tokens)) {
    const addr = edge[needle].toLowerCase();
    const idx = tokens.findIndex((t: unknown) => typeof t === "string" && t.toLowerCase() === addr);
    if (idx >= 0) return idx;
  }
  return needle === "tokenIn" ? 0 : 1;
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
  if (u.includes("V3") || u === "KYBERSWAP_ELASTIC") return "V3";
  if (u.includes("V2")) return "V2";
  return u;
}

/** Dispatch a single hop simulation to the correct math module. */
export function simulateHop(
  edge: SimulationEdge,
  amountIn: bigint,
  stateCache: RouteStateCache,
): SimulatedHopResult {
  const state = edge.stateRef ?? stateCache.get(edge.poolAddress.toLowerCase());
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

function extractGasResult(r: {
  amountOut: bigint;
  gasEstimate: number;
}): SimulatedHopResult {
  return { amountOut: r.amountOut, gasEstimate: r.gasEstimate };
}

/** Simulate a full multi-hop route. Direction is inferred from stateRef. */
export function simulateRoute(
  edges: SwapEdge[],
  amountIn: bigint,
  stateCache: RouteStateCache,
): RouteSimulationResult {
  const hopAmounts: bigint[] = [amountIn];
  let totalGas = 0;
  const poolPath: string[] = [];
  const tokenPath: string[] = [];
  const protocols: string[] = [];

  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    const state = (edge.stateRef ?? stateCache.get(edge.poolAddress.toLowerCase())) as Record<string, unknown> | undefined;
    if (!state) throw new Error(`No state for pool ${edge.poolAddress}`);

    const simEdge: SimulationEdge = {
      poolAddress: edge.poolAddress,
      tokenIn: edge.tokenIn,
      tokenOut: edge.tokenOut,
      protocol: edge.protocol,
      zeroForOne: inferZeroForOne(edge, state),
      tokenInIdx: inferTokenIdx(edge, "tokenIn", state),
      tokenOutIdx: inferTokenIdx(edge, "tokenOut", state),
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
