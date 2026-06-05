import type { PoolState } from "../core/types/pool.ts";
import { isInvalidState } from "../core/types/pool.ts";
import type { PendingStateOverlay } from "../core/types/overlay.ts";
import type { Address } from "../core/types/common.ts";
import type { SimulatedHopResult, RouteSimulationResult, RouteStateCache } from "../core/types/route.ts";
import { simulateV2Swap, resolveV2Fee } from "../core/math/uniswap_v2.ts";
import { simulateV3Swap } from "../core/math/uniswap_v3.ts";
import { simulateCurveSwap } from "../core/math/curve.ts";
import { simulateBalancerSwap } from "../core/math/balancer.ts";
import { simulateDodoSwap } from "../core/math/dodo.ts";
import { simulateWoofiSwap } from "../core/math/woofi.ts";
import { BPS_DENOM } from "../core/constants.ts";
import type { SwapEdge, SimulationEdge } from "./types.ts";
import { USDC, USDC_NATIVE, USDT, WBTC } from "../config/addresses.ts";

export function normalizeProtocol(raw: string): string {
  const u = raw.toUpperCase();
  if (u.startsWith("CURVE")) return "CURVE";
  if (u.startsWith("BALANCER")) return "BALANCER";
  if (u.startsWith("DODO")) return "DODO";
  if (u.startsWith("WOOFI")) return "WOOFI";
  if (u.includes("V3") || u === "KYBERSWAP_ELASTIC" || u === "UNISWAP_V4") return "V3";
  if (u.includes("V2")) return "V2";
  return u;
}

export function computeSpotPrice(
  normalizedProtocol: string,
  zeroForOne: boolean,
  tokenInIdx: number | undefined,
  tokenOutIdx: number | undefined,
  state: PoolState,
): number {
  if (normalizedProtocol === "V2") {
    const r0 = state.reserve0 as bigint | undefined;
    const r1 = state.reserve1 as bigint | undefined;
    if (r0 && r1) {
      return zeroForOne ? Number(r1) / Number(r0) : Number(r0) / Number(r1);
    }
  } else if (normalizedProtocol === "V3" || normalizedProtocol === "V4") {
    const sqrtPriceX96 = state.sqrtPriceX96 as bigint | undefined;
    if (sqrtPriceX96 && sqrtPriceX96 > 0n) {
      const price = (Number(sqrtPriceX96) / 2 ** 96) ** 2;
      if (price > 0) {
        return zeroForOne ? price : 1 / price;
      }
    }
  } else if (normalizedProtocol === "BALANCER") {
    const balances = state.balances as bigint[] | undefined;
    const weights = state.weights as bigint[] | undefined;
    if (balances && balances.length >= 2 && weights && weights.length >= 2) {
      const inIdx = tokenInIdx ?? (zeroForOne ? 0 : 1);
      const outIdx = tokenOutIdx ?? (zeroForOne ? 1 : 0);
      if (balances[inIdx] > 0n && balances[outIdx] > 0n && weights[inIdx] > 0n && weights[outIdx] > 0n) {
        return Number(balances[outIdx] * weights[inIdx]) / Number(balances[inIdx] * weights[outIdx]);
      }
    }
  } else if (normalizedProtocol === "CURVE") {
    const balances = state.balances as bigint[] | undefined;
    if (balances && balances.length >= 2) {
      const inIdx = tokenInIdx ?? (zeroForOne ? 0 : 1);
      const outIdx = tokenOutIdx ?? (zeroForOne ? 1 : 0);
      if (balances[inIdx] > 0n && balances[outIdx] > 0n) {
        return Number(balances[outIdx]) / Number(balances[inIdx]);
      }
    }
  } else if (normalizedProtocol === "DODO") {
    const b = state.baseReserve as bigint | undefined;
    const q = state.quoteReserve as bigint | undefined;
    if (b && q && b > 0n && q > 0n) {
      return zeroForOne ? Number(q) / Number(b) : Number(b) / Number(q);
    }
  } else if (normalizedProtocol === "WOOFI") {
    const rawPrice = state.price as bigint | undefined;
    if (rawPrice && rawPrice > 0n) {
      return zeroForOne ? Number(rawPrice) / 1e18 : 1e18 / Number(rawPrice);
    }
  }
  return 0;
}

export function simulateHop(
  edge: SimulationEdge,
  amountIn: bigint,
  stateCache: RouteStateCache,
  overlay?: PendingStateOverlay,
): SimulatedHopResult {
  const poolAddr = edge.poolAddress.toLowerCase();
  const baseState = stateCache.get(poolAddr) ?? edge.stateRef;
  if (!baseState) throw new Error(`No valid state for pool ${edge.poolAddress}`);
  const state = overlay?.getProjected(edge.poolAddress as Address, baseState) ?? baseState;
  if (!state || isInvalidState(state)) throw new Error(`No valid state for pool ${edge.poolAddress}`);

  let result: SimulatedHopResult;

  switch (edge.normalizedProtocol) {
    case "V2":
      const feeBps = edge.swapFeeBps != null ? BigInt(edge.swapFeeBps) : edge.fee != null ? BigInt(edge.fee) : undefined;
      const { numerator, denominator } = resolveV2Fee(state, undefined, 10000n);

      // If fee was explicitly provided in the edge, use it to derive numerator.
      // feeBps is in basis points (30 bps = 0.3%). The correct numerator is:
      //   numerator = denominator - (feeBps * denominator) / BPS_DENOM
      // For 30 bps with denominator = 1000: 1000 - (30 * 1000) / 10000 = 1000 - 3 = 997
      let finalNum = numerator;
      if (feeBps !== undefined) {
        finalNum = feeBps < 500n ? denominator - (feeBps * denominator) / BPS_DENOM : feeBps;
      }

      result = simulateV2Swap(state, amountIn, edge.zeroForOne, finalNum, denominator);
      break;
    case "V3":
      result = extractGasResult(simulateV3Swap(state, amountIn, edge.zeroForOne, edge.fee != null ? Number(edge.fee) : undefined));
      break;
    case "CURVE":
      result = simulateCurveSwap(amountIn, state, edge.tokenInIdx ?? 0, edge.tokenOutIdx ?? 1);
      break;
    case "BALANCER":
      result = simulateBalancerSwap(amountIn, state, edge.tokenInIdx ?? 0, edge.tokenOutIdx ?? 1);
      break;
    case "DODO":
      result = simulateDodoSwap(state, amountIn, edge.zeroForOne);
      break;
    case "WOOFI":
      result = simulateWoofiSwap(amountIn, state, edge.tokenInIdx ?? 0, edge.tokenOutIdx ?? 1);
      break;
    default:
      throw new Error(`Unknown protocol: ${edge.protocol}`);
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
  prebuiltSimEdges?: SimulationEdge[],
  overlay?: PendingStateOverlay,
): RouteSimulationResult {
  const hopAmounts: bigint[] = [amountIn];
  let totalGas = 0;
  const poolPath: string[] = [];
  const tokenPath: string[] = [];
  const protocols: string[] = [];

  const simEdges = prebuiltSimEdges ?? buildSimulationEdges(edges, stateCache);
  if (!simEdges) throw new Error("Missing state for simulation");

  for (let i = 0; i < simEdges.length; i++) {
    const simEdge = simEdges[i];
    if (!prebuiltSimEdges) {
      const base = stateCache.get(simEdge.poolAddress) ?? simEdge.stateRef;
      if (!base) throw new Error(`No valid state for pool ${simEdge.poolAddress}`);
      const state = overlay?.getProjected(simEdge.poolAddress as Address, base) ?? base;
      if (!state || isInvalidState(state)) {
        throw new Error(`No valid state for pool ${simEdge.poolAddress}`);
      }
    }

    const hop = simulateHop(simEdge, hopAmounts[i], stateCache, overlay);
    hopAmounts.push(hop.amountOut);
    totalGas += hop.gasEstimate;
    poolPath.push(edges[i].poolAddress);
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
  prebuiltSimEdges?: SimulationEdge[],
  overlay?: PendingStateOverlay,
): { profit: bigint; totalGas: number; amountOut: bigint } {
  let currentAmount = amountIn;
  let totalGas = 0;

  const simEdges = prebuiltSimEdges ?? buildSimulationEdges(edges, stateCache);
  if (!simEdges) throw new Error("Missing state for simulation");

  for (let i = 0; i < simEdges.length; i++) {
    const simEdge = simEdges[i];
    if (!prebuiltSimEdges) {
      const base = stateCache.get(simEdge.poolAddress as `0x${string}`) ?? simEdge.stateRef;
      if (!base) throw new Error(`No valid state for pool ${simEdge.poolAddress}`);
      const state = overlay?.getProjected(simEdge.poolAddress as Address, base) ?? base;
      if (!state || isInvalidState(state)) {
        throw new Error(`No valid state for pool ${simEdge.poolAddress}`);
      }
    }

    const hop = simulateHop(simEdge, currentAmount, stateCache, overlay);
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
  stateCache: RouteStateCache,
  overlay?: PendingStateOverlay,
): SimulationEdge[] | null {
  const simEdges: SimulationEdge[] = new Array(edges.length);

  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    const poolAddr = edge.poolAddress.toLowerCase();
    const baseState = stateCache.get(poolAddr) ?? (edge.stateRef as PoolState | undefined);
    if (!baseState) {
      // console.warn(`Missing base state for pool ${poolAddr}`);
      return null;
    }
    const state = overlay?.getProjected(edge.poolAddress as Address, baseState) ?? baseState;

    if (isInvalidState(state)) {
      // console.warn(`Invalid state for pool ${poolAddr}`);
      return null;
    }

    simEdges[i] = {
      poolAddress: poolAddr,
      tokenIn: edge.tokenIn,
      tokenOut: edge.tokenOut,
      protocol: edge.protocol,
      normalizedProtocol: normalizeProtocol(edge.protocol),
      zeroForOne: edge.zeroForOne,
      tokenInIdx: edge.tokenInIdx,
      tokenOutIdx: edge.tokenOutIdx,
      fee: edge.feeBps,
      stateRef: state as PoolState,
    };
  }

  return simEdges;
}

/**
 * Combined minimal simulation + impact check in a single pass.
 * Calls simulateHop once per edge, uses the result for both impact checking
 * and amount propagation. (Legacy getEffectivePriceImpact path removed; this
 * replaces the prior 2-3x hop calls during search/impact.)
 */
export function simulateMinimalWithImpactCheck(
  edges: SwapEdge[],
  amountIn: bigint,
  stateCache: RouteStateCache,
  prebuiltSimEdges: SimulationEdge[] | undefined,
  maxImpactThreshold: number,
  overlay?: PendingStateOverlay,
): { success: boolean; profit: bigint; totalGas: number; amountOut: bigint } {
  const simEdges = prebuiltSimEdges ?? buildSimulationEdges(edges, stateCache);
  if (!simEdges) throw new Error("Missing state for simulation");
  let currentAmount = amountIn;
  let totalGas = 0;

  for (let i = 0; i < simEdges.length; i++) {
    const simEdge = simEdges[i];
    if (!prebuiltSimEdges) {
      const baseForEdge = stateCache.get(simEdge.poolAddress) ?? simEdge.stateRef;
      if (!baseForEdge) return { success: false, profit: 0n, totalGas: 0, amountOut: 0n };
      const state = overlay?.getProjected(simEdge.poolAddress as Address, baseForEdge) ?? baseForEdge;
      if (!state || isInvalidState(state)) return { success: false, profit: 0n, totalGas: 0, amountOut: 0n };
    }

    const hop = simulateHop(simEdge, currentAmount, stateCache, overlay);

    const base = stateCache.get(simEdge.poolAddress) ?? simEdge.stateRef;
    if (!base) return { success: false, profit: 0n, totalGas: 0, amountOut: 0n };
    const state = overlay?.getProjected(simEdge.poolAddress as Address, base) ?? base;
    if (state) {
      const realizedPrice = Number(hop.amountOut) / Number(currentAmount);
      const spotPrice = computeSpotPrice(simEdge.normalizedProtocol, simEdge.zeroForOne, simEdge.tokenInIdx, simEdge.tokenOutIdx, state);
      if (spotPrice > 0) {
        const impact = (spotPrice - realizedPrice) / spotPrice;
        if (impact > maxImpactThreshold) return { success: false, profit: 0n, totalGas: 0, amountOut: 0n };
      }
    }

    currentAmount = hop.amountOut;
    totalGas += hop.gasEstimate;
  }

  return { success: true, profit: currentAmount - amountIn, totalGas, amountOut: currentAmount };
}

export function getTestAmount(tokenAddress: string, metas?: Map<string, { decimals: number }>): bigint {
  const addr = tokenAddress.toLowerCase();

  if (addr === USDC.toLowerCase() || addr === USDC_NATIVE.toLowerCase() || addr === USDT.toLowerCase()) {
    return 100n * 10n ** 6n;
  }
  if (addr === WBTC.toLowerCase()) {
    return 70_000n;
  }
  if (addr === "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619") {
    return 30_000_000_000_000_000n;
  }
  if (addr === "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270") {
    return 50n * 10n ** 18n;
  }

  const decimals = metas?.get(addr)?.decimals ?? 18;
  return 10n * 10n ** BigInt(decimals);
}
