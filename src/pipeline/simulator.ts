import type { PoolState } from "../core/types/pool.ts";
import { isInvalidState } from "../core/types/pool.ts";
import type { SimulatedHopResult, RouteSimulationResult, RouteStateCache } from "../core/types/route.ts";
import { simulateV2Swap } from "../core/math/uniswap_v2.ts";
import { simulateV3Swap } from "../core/math/uniswap_v3.ts";
import { simulateCurveSwap } from "../core/math/curve.ts";
import { simulateBalancerSwap } from "../core/math/balancer.ts";
import { simulateDodoSwap } from "../core/math/dodo.ts";
import { simulateWoofiSwap } from "../core/math/woofi.ts";
import type { SwapEdge, SimulationEdge } from "./types.ts";
import { TokenRegistry } from "./token_registry.ts";
import { USDC, USDC_NATIVE, USDT, WBTC } from "../config/addresses.ts";

function normalizeProtocol(raw: string): string {
  const u = raw.toUpperCase();
  if (u.startsWith("CURVE")) return "CURVE";
  if (u.startsWith("BALANCER")) return "BALANCER";
  if (u.startsWith("DODO")) return "DODO";
  if (u.startsWith("WOOFI")) return "WOOFI";
  if (u.includes("V3") || u === "KYBERSWAP_ELASTIC" || u === "UNISWAP_V4") return "V3";
  if (u.includes("V2")) return "V2";
  return u;
}

export function simulateHop(
  edge: SimulationEdge,
  amountIn: bigint,
  stateCache: RouteStateCache,
  tokenRegistry?: TokenRegistry,
): SimulatedHopResult {
  const poolAddr = edge.poolAddress.toLowerCase();
  const state = stateCache.get(poolAddr) ?? edge.stateRef;
  if (!state || isInvalidState(state)) throw new Error(`No valid state for pool ${edge.poolAddress}`);

  const effectiveAmountIn = tokenRegistry ? tokenRegistry.applySellTax(edge.tokenIn, amountIn) : amountIn;

  let result: SimulatedHopResult;

  switch (normalizeProtocol(edge.protocol)) {
    case "V2":
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

  if (tokenRegistry) {
    result.amountOut = tokenRegistry.applyBuyTax(edge.tokenOut, result.amountOut);
  }

  return result;
}

function extractGasResult(r: { amountOut: bigint; gasEstimate: number }): SimulatedHopResult {
  return { amountOut: r.amountOut, gasEstimate: r.gasEstimate };
}

export function simulateRoute(
  edges: SwapEdge[],
  amountIn: bigint,
  stateCache: RouteStateCache,
  tokenRegistry?: TokenRegistry,
  prebuiltSimEdges?: SimulationEdge[],
): RouteSimulationResult {
  const hopAmounts: bigint[] = [amountIn];
  let totalGas = 0;
  const poolPath: string[] = [];
  const tokenPath: string[] = [];
  const protocols: string[] = [];

  const simEdges = prebuiltSimEdges ?? buildSimulationEdges(edges, stateCache);

  for (let i = 0; i < simEdges.length; i++) {
    const simEdge = simEdges[i];
    if (!prebuiltSimEdges) {
      const state = stateCache.get(simEdge.poolAddress) ?? simEdge.stateRef;
      if (!state || isInvalidState(state)) {
        throw new Error(`No valid state for pool ${simEdge.poolAddress}`);
      }
    }

    const hop = simulateHop(simEdge, hopAmounts[i], stateCache, tokenRegistry);
    hopAmounts.push(hop.amountOut);
    totalGas += hop.gasEstimate;
    poolPath.push(edges[i].poolAddress); // use original edges for original casing if needed
    tokenPath.push(edges[i].tokenIn);
    protocols.push(edges[i].protocol);
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

/**
 * Minimal simulation used during ternary search / amount probing.
 * Avoids allocating hopAmounts, poolPath, tokenPath, protocols arrays.
 * Only returns the numeric values needed for profit/grossMatic comparison.
 * This is a major allocation reduction in the hot path (called 20-40x per cycle during search).
 */
export function simulateRouteMinimal(
  edges: SwapEdge[],
  amountIn: bigint,
  stateCache: RouteStateCache,
  tokenRegistry?: TokenRegistry,
  prebuiltSimEdges?: SimulationEdge[],
): { profit: bigint; totalGas: number; amountOut: bigint } {
  let currentAmount = amountIn;
  let totalGas = 0;

  const simEdges = prebuiltSimEdges ?? buildSimulationEdges(edges, stateCache);

  for (let i = 0; i < simEdges.length; i++) {
    const simEdge = simEdges[i];
    // Basic validity check only if we built them ourselves (prebuilt are assumed valid)
    if (!prebuiltSimEdges) {
      const state = stateCache.get(simEdge.poolAddress) ?? simEdge.stateRef;
      if (!state || isInvalidState(state)) {
        throw new Error(`No valid state for pool ${simEdge.poolAddress}`);
      }
    }

    const hop = simulateHop(simEdge, currentAmount, stateCache, tokenRegistry);
    currentAmount = hop.amountOut;
    totalGas += hop.gasEstimate;
  }

  const amountOut = currentAmount;
  const profit = amountOut - amountIn;

  return { profit, totalGas, amountOut };
}

/**
 * Pre-builds SimulationEdge objects for a cycle once.
 * This eliminates repeated object allocation inside every simulateRouteMinimal / simulateRoute call
 * during ternary search (the dominant hot-path allocation source).
 */
export function buildSimulationEdges(
  edges: SwapEdge[],
  stateCache: RouteStateCache
): SimulationEdge[] {
  const simEdges: SimulationEdge[] = new Array(edges.length);

  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    const poolAddr = edge.poolAddress.toLowerCase();
    const state = stateCache.get(poolAddr) ?? edge.stateRef;

    simEdges[i] = {
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
  }

  return simEdges;
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

export function getTestAmount(tokenAddress: string, metas?: Map<string, { decimals: number }>): bigint {
  const addr = tokenAddress.toLowerCase();
  
  if (addr === USDC.toLowerCase() || addr === USDC_NATIVE.toLowerCase() || addr === USDT.toLowerCase()) {
    return 500n * 10n ** 6n;
  }
  if (addr === WBTC.toLowerCase()) {
    return 700_000n;
  }
  if (addr === "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619") {
    return 160_000_000_000_000_000n;
  }
  if (addr === "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270") {
    return 800n * 10n ** 18n;
  }

  const decimals = metas?.get(addr)?.decimals ?? 18;
  return 500n * 10n ** BigInt(decimals);
}
