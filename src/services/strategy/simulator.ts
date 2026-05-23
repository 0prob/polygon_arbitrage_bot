import type { PoolState } from "../../core/types/pool.ts";
import type { SimulatedHopResult, RouteSimulationResult, RouteStateCache } from "../../core/types/route.ts";
import { simulateV2Swap } from "../../core/math/uniswap_v2.ts";
import { simulateV3Swap } from "../../core/math/uniswap_v3.ts";
import { simulateCurveSwap } from "../../core/math/curve.ts";
import { simulateBalancerSwap } from "../../core/math/balancer.ts";
import { simulateDodoSwap } from "../../core/math/dodo.ts";
import { simulateWoofiSwap } from "../../core/math/woofi.ts";
import type { SwapEdge } from "./graph.ts";
import { TokenRegistry } from "./token_registry.ts";

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
export function simulateHop(
  edge: SimulationEdge,
  amountIn: bigint,
  stateCache: RouteStateCache,
  tokenRegistry?: TokenRegistry
): SimulatedHopResult {
  const poolAddr = edge.poolAddress.toLowerCase();
  const state = stateCache.get(poolAddr) ?? edge.stateRef;
  if (!state) throw new Error(`No state for pool ${edge.poolAddress}`);

  // Apply sell tax: What the pool actually receives
  const effectiveAmountIn = tokenRegistry ? tokenRegistry.applySellTax(edge.tokenIn, amountIn) : amountIn;

  let result: SimulatedHopResult;

  switch (normalizeProtocol(edge.protocol)) {
    case "V2":
      result = simulateV2Swap(state, effectiveAmountIn, edge.zeroForOne);
      break;
    case "V3":
      result = extractGasResult(simulateV3Swap(state, effectiveAmountIn, edge.zeroForOne));
      break;
    case "CURVE":
      result = simulateCurveSwap(effectiveAmountIn, state, edge.tokenInIdx ?? 0, edge.tokenOutIdx ?? 1);
      break;
    case "BALANCER":
      result = simulateBalancerSwap(effectiveAmountIn, state, edge.tokenInIdx ?? 0, edge.tokenOutIdx ?? 1);
      break;
    case "DODO":
      result = simulateDodoSwap(state, effectiveAmountIn, edge.zeroForOne);
      break;
    case "WOOFI":
      result = simulateWoofiSwap(effectiveAmountIn, state, edge.tokenInIdx ?? 0, edge.tokenOutIdx ?? 1);
      break;
    default:
      throw new Error(`Unknown protocol: ${edge.protocol}`);
  }

  // Apply buy tax: What the user actually receives
  if (tokenRegistry) {
    result.amountOut = tokenRegistry.applyBuyTax(edge.tokenOut, result.amountOut);
  }

  return result;
}

function extractGasResult(r: { amountOut: bigint; gasEstimate: number }): SimulatedHopResult {
  return { amountOut: r.amountOut, gasEstimate: r.gasEstimate };
}

/** Simulate a full multi-hop route. Direction is inferred from stateRef. */
export function simulateRoute(
  edges: SwapEdge[],
  amountIn: bigint,
  stateCache: RouteStateCache,
  tokenRegistry?: TokenRegistry
): RouteSimulationResult {
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

    const hop = simulateHop(simEdge, hopAmounts[i], stateCache, tokenRegistry);
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

export function getEffectivePriceImpact(edge: SwapEdge, amountIn: bigint, stateCache: RouteStateCache, tokenRegistry?: TokenRegistry): number {
  if (amountIn === 0n) return 0;

  const poolAddr = edge.poolAddress.toLowerCase();
  const state = (stateCache.get(poolAddr) ?? edge.stateRef) as PoolState | undefined;
  if (!state) return 0;

  const simEdge: SimulationEdge = {
    poolAddress: edge.poolAddress,
    tokenIn: edge.tokenIn,
    tokenOut: edge.tokenOut,
    protocol: edge.protocol,
    zeroForOne: edge.zeroForOne,
    tokenInIdx: edge.tokenInIdx,
    tokenOutIdx: edge.tokenOutIdx,
    stateRef: state,
  };

  const result = simulateHop(simEdge, amountIn, stateCache, tokenRegistry);
  const realizedPrice = Number(result.amountOut) / Number(amountIn);

  let spotPrice = 1.0;
  const protocol = normalizeProtocol(edge.protocol);

  if (protocol === "V2") {
    const r0 = state.reserve0 as bigint | undefined;
    const r1 = state.reserve1 as bigint | undefined;
    if (r0 && r1) {
      spotPrice = edge.zeroForOne ? Number(r1) / Number(r0) : Number(r0) / Number(r1);
    }
  } else if (protocol === "V3") {
    const sqrtPriceX96 = state.sqrtPriceX96 as bigint | undefined;
    if (sqrtPriceX96) {
      const price = (Number(sqrtPriceX96) / 2 ** 96) ** 2;
      spotPrice = edge.zeroForOne ? price : 1 / price;
    }
  }

  if (spotPrice === 0) return 0;
  const impact = Math.abs(spotPrice - realizedPrice) / spotPrice;
  return impact;
}
