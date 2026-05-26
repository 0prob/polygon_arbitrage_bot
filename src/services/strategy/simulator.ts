import type { PoolState } from "../../core/types/pool.ts";
import { isInvalidState } from "../../core/types/pool.ts";
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
  tokenRegistry?: TokenRegistry,
): SimulatedHopResult {
  const poolAddr = edge.poolAddress.toLowerCase();
  const state = stateCache.get(poolAddr) ?? edge.stateRef;
  if (!state || isInvalidState(state)) throw new Error(`No valid state for pool ${edge.poolAddress}`);

  // Apply sell tax: What the pool actually receives
  const effectiveAmountIn = tokenRegistry ? tokenRegistry.applySellTax(edge.tokenIn, amountIn) : amountIn;

  let result: SimulatedHopResult;

  switch (normalizeProtocol(edge.protocol)) {
    case "V2":
      // Priority: edge.swapFeeBps -> edge.fee -> default (30 bps)
      const feeBps = edge.swapFeeBps != null ? BigInt(edge.swapFeeBps) : 
                    (edge.fee != null ? (BigInt(edge.fee) < 1000n ? BigInt(edge.fee) : (10000n - BigInt(edge.fee))) : 30n);
      
      result = simulateV2Swap(state, effectiveAmountIn, edge.zeroForOne, 10000n - feeBps, 10000n);
      break;
    case "V3":
      result = extractGasResult(simulateV3Swap(state, effectiveAmountIn, edge.zeroForOne, edge.fee != null ? Number(edge.fee) : undefined));
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
  tokenRegistry?: TokenRegistry,
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
    if (!state || isInvalidState(state)) throw new Error(`No valid state for pool ${edge.poolAddress}`);

    const simEdge: SimulationEdge = {
      poolAddress: poolAddr,
      tokenIn: edge.tokenIn,
      tokenOut: edge.tokenOut,
      protocol: edge.protocol,
      zeroForOne: edge.zeroForOne,
      tokenInIdx: edge.tokenInIdx,
      tokenOutIdx: edge.tokenOutIdx,
      fee: edge.feeBps,
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

export function getEffectivePriceImpact(
  edge: SwapEdge,
  amountIn: bigint,
  stateCache: RouteStateCache,
  tokenRegistry?: TokenRegistry,
): number {
  if (amountIn === 0n) return 0;

  const poolAddr = edge.poolAddress.toLowerCase();
  const state = (stateCache.get(poolAddr) ?? edge.stateRef) as PoolState | undefined;
  if (!state || isInvalidState(state)) return 0;

  const simEdge: SimulationEdge = {
    poolAddress: edge.poolAddress,
    tokenIn: edge.tokenIn,
    tokenOut: edge.tokenOut,
    protocol: edge.protocol,
    zeroForOne: edge.zeroForOne,
    tokenInIdx: edge.tokenInIdx,
    tokenOutIdx: edge.tokenOutIdx,
    fee: edge.feeBps,
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
  } else if (protocol === "V3" || protocol === "V4") {
    const sqrtPriceX96 = state.sqrtPriceX96 as bigint | undefined;
    if (sqrtPriceX96) {
      const price = (Number(sqrtPriceX96) / 2 ** 96) ** 2;
      spotPrice = edge.zeroForOne ? price : 1 / price;
    }
  } else if (protocol === "BALANCER") {
    const balances = state.balances as bigint[] | undefined;
    const weights = state.weights as bigint[] | undefined;
    if (balances && balances.length >= 2 && weights && weights.length >= 2) {
      const inIdx = edge.tokenInIdx ?? (edge.zeroForOne ? 0 : 1);
      const outIdx = edge.tokenOutIdx ?? (edge.zeroForOne ? 1 : 0);
      if (balances[inIdx] > 0n && balances[outIdx] > 0n && weights[inIdx] > 0n && weights[outIdx] > 0n) {
        // spotPrice = (balanceOut * weightIn) / (balanceIn * weightOut)
        spotPrice = Number(balances[outIdx] * weights[inIdx]) / Number(balances[inIdx] * weights[outIdx]);
      }
    }
  } else if (protocol === "CURVE") {
    const balances = state.balances as bigint[] | undefined;
    if (balances && balances.length >= 2) {
      const inIdx = edge.tokenInIdx ?? (edge.zeroForOne ? 0 : 1);
      const outIdx = edge.tokenOutIdx ?? (edge.zeroForOne ? 1 : 0);
      if (balances[inIdx] > 0n && balances[outIdx] > 0n) {
        spotPrice = Number(balances[outIdx]) / Number(balances[inIdx]);
      }
    }
  } else if (protocol === "DODO") {
    const b = state.baseReserve as bigint | undefined;
    const q = state.quoteReserve as bigint | undefined;
    if (b && q && b > 0n && q > 0n) {
      // DODO: base = 0, quote = 1. zeroForOne = base -> quote
      spotPrice = edge.zeroForOne ? Number(q) / Number(b) : Number(b) / Number(q);
    }
  } else if (protocol === "WOOFI") {
    const rawPrice = state.price as bigint | undefined;
    if (rawPrice && rawPrice > 0n) {
      spotPrice = edge.zeroForOne ? Number(rawPrice) / 1e18 : 1e18 / Number(rawPrice);
    }
  }

  if (spotPrice === 0) return 0;
  const impact = (spotPrice - realizedPrice) / spotPrice;
  return impact;
}
