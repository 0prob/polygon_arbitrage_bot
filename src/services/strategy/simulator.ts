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

/** Dispatch a single hop simulation to the correct math module. */
export function simulateHop(edge: SimulationEdge, amountIn: bigint, stateCache: RouteStateCache): SimulatedHopResult {
  const poolAddr = edge.poolAddress.toLowerCase();
  const state = stateCache.get(poolAddr) ?? edge.stateRef;
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
    const poolAddr = edge.poolAddress.toLowerCase();
    const state = stateCache.get(poolAddr) ?? edge.stateRef;
    if (!state) throw new Error(`No state for pool ${edge.poolAddress}`);
    const stateRecord = state as Record<string, unknown>;

    const simEdge: SimulationEdge = {
      poolAddress: poolAddr,
      tokenIn: edge.tokenIn,
      tokenOut: edge.tokenOut,
      protocol: edge.protocol,
      zeroForOne: edge.zeroForOne,
      tokenInIdx: edge.tokenInIdx,
      tokenOutIdx: edge.tokenOutIdx,
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

  tokenPath.push(edges[edges.length - 1]?.tokenOut ?? "");

  return {
    amountIn,
    amountOut,
    profit,
    profitable: profit > 0n,
    hopAmounts,
    totalGas,
    poolPath,
    tokenPath,
    protocols,
    hopCount: edges.length,
  };
}

export function getEffectivePriceImpact(edge: SwapEdge, amountIn: bigint, stateCache: RouteStateCache): number {
  if (amountIn === 0n) return 0;
  const simEdge: SimulationEdge = {
    poolAddress: edge.poolAddress,
    tokenIn: edge.tokenIn,
    tokenOut: edge.tokenOut,
    protocol: edge.protocol,
    zeroForOne: edge.zeroForOne ?? true, // Simplified
    stateRef: edge.stateRef as PoolState,
  };

  const result = simulateHop(simEdge, amountIn, stateCache);
  const realizedPrice = Number(result.amountOut) / Number(amountIn);
  
  // Need to compare with spot price. For simplicity, we assume 1:1 if not found.
  // This is a naive implementation as requested.
  const spotPrice = 1.0; 
  const impact = Math.abs(spotPrice - realizedPrice) / spotPrice;
  return impact;
}
