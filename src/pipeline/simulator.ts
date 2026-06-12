import type { PoolState } from "../core/types/pool.ts";
import { isInvalidState } from "../core/types/pool.ts";
import type { PendingStateOverlay } from "../core/types/overlay.ts";
import type { PendingOverrideStore } from "../services/mempool/pending-override.ts";
import { getProjectedPoolState } from "../services/mempool/override_projection.ts";
import type { Address } from "../core/types/common.ts";
import type { SimulatedHopResult, RouteSimulationResult, RouteStateCache } from "../core/types/route.ts";
import { simulateV2Swap, resolveV2Fee } from "../core/math/uniswap_v2.ts";
import { simulateV3Swap } from "../core/math/uniswap_v3.ts";
import { simulateV4Swap } from "../core/math/uniswap_v4.ts";
import { simulateCurveSwap } from "../core/math/curve.ts";
import { simulateBalancerSwap } from "../core/math/balancer.ts";
import { simulateDodoSwap } from "../core/math/dodo.ts";
import { simulateWoofiSwap } from "../core/math/woofi.ts";
import { BPS_DENOM } from "../core/constants.ts";
import type { SwapEdge, SimulationEdge } from "./types.ts";
import { USDC, USDC_NATIVE, USDT, WBTC } from "../config/addresses.ts";
import { normalizeProtocol } from "../core/utils/protocol.ts";

function isShallowV3State(state: PoolState | undefined): boolean {
  if (!state) return false;
  const ticks = (state as Record<string, unknown>).ticks;
  return !(ticks instanceof Map && ticks.size > 0);
}

function effectiveImpactThreshold(
  normalizedProtocol: string,
  state: PoolState | undefined,
  maxImpactThreshold: number,
  v3ShallowMaxImpactBps?: number,
): number {
  if (
    (normalizedProtocol === "V3" || normalizedProtocol === "V4") &&
    isShallowV3State(state)
  ) {
    const shallowBps = v3ShallowMaxImpactBps ?? 30;
    return Math.min(maxImpactThreshold, shallowBps / 10_000);
  }
  return maxImpactThreshold;
}

function bnToSafeNumber(v: bigint): number {
  if (v === 0n) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
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
      const n0 = bnToSafeNumber(r0);
      const n1 = bnToSafeNumber(r1);
      if (n0 > 0 && n1 > 0) {
        return zeroForOne ? n1 / n0 : n0 / n1;
      }
    }
  } else if (normalizedProtocol === "V3" || normalizedProtocol === "V4") {
    const sqrtPriceX96 = state.sqrtPriceX96 as bigint | undefined;
    if (sqrtPriceX96 && sqrtPriceX96 > 0n) {
      const nSqrt = bnToSafeNumber(sqrtPriceX96);
      if (nSqrt > 0) {
        const price = (nSqrt / 2 ** 96) ** 2;
        if (Number.isFinite(price) && price > 0) {
          return zeroForOne ? price : 1 / price;
        }
      }
    }
  } else if (normalizedProtocol === "BALANCER") {
    const balances = state.balances as bigint[] | undefined;
    const weights = state.weights as bigint[] | undefined;
    if (balances && balances.length >= 2 && weights && weights.length >= 2) {
      const inIdx = tokenInIdx ?? (zeroForOne ? 0 : 1);
      const outIdx = tokenOutIdx ?? (zeroForOne ? 1 : 0);
      if (balances[inIdx] > 0n && balances[outIdx] > 0n && weights[inIdx] > 0n && weights[outIdx] > 0n) {
        const num = bnToSafeNumber(balances[outIdx] * weights[inIdx]);
        const den = bnToSafeNumber(balances[inIdx] * weights[outIdx]);
        if (den > 0) return num / den;
      }
    }
  } else if (normalizedProtocol === "CURVE") {
    const balances = state.balances as bigint[] | undefined;
    if (balances && balances.length >= 2) {
      const inIdx = tokenInIdx ?? (zeroForOne ? 0 : 1);
      const outIdx = tokenOutIdx ?? (zeroForOne ? 1 : 0);
      if (balances[inIdx] > 0n && balances[outIdx] > 0n) {
        const num = bnToSafeNumber(balances[outIdx]);
        const den = bnToSafeNumber(balances[inIdx]);
        if (den > 0) return num / den;
      }
    }
  } else if (normalizedProtocol === "DODO") {
    const b = state.baseReserve as bigint | undefined;
    const q = state.quoteReserve as bigint | undefined;
    if (b && q && b > 0n && q > 0n) {
      const nB = bnToSafeNumber(b);
      const nQ = bnToSafeNumber(q);
      if (nB > 0 && nQ > 0) {
        return zeroForOne ? nQ / nB : nB / nQ;
      }
    }
  } else if (normalizedProtocol === "WOOFI") {
    const rawPrice = state.price as bigint | undefined;
    if (rawPrice && rawPrice > 0n) {
      const nPrice = bnToSafeNumber(rawPrice);
      if (nPrice > 0) {
        return zeroForOne ? nPrice / 1e18 : 1e18 / nPrice;
      }
    }
  }
  return 0;
}

export function simulateHop(
  edge: SimulationEdge,
  amountIn: bigint,
  _stateCache?: RouteStateCache,
  _overlay?: PendingStateOverlay,
): SimulatedHopResult {
  const state = edge.stateRef;
  if (!state || isInvalidState(state)) {
    throw new Error(`No valid state for pool ${edge.poolAddress}`);
  }

  let result: SimulatedHopResult;

  switch (edge.normalizedProtocol) {
    case "V2": {
      const edgeFeeBps = edge.swapFeeBps != null ? BigInt(edge.swapFeeBps) : edge.fee != null ? BigInt(edge.fee) : undefined;

      // Resolve fee from pool state or default (0.3%). The denominator from
      // resolveV2Fee is the authoritative value; we only override the numerator
      // if the edge explicitly provides a feeBps.
      const { numerator, denominator } = resolveV2Fee(state, undefined, 10000n);
      let feeNum = numerator;

      if (edgeFeeBps !== undefined) {
        // Convert BPS to fee numerator: feeNum = denominator * (1 - bps/10000)
        // For 30 bps with denominator = 1000: 1000 - (30 * 1000) / 10000 = 997
        feeNum = edgeFeeBps < 500n ? denominator - (edgeFeeBps * denominator) / BPS_DENOM : edgeFeeBps;
      } else if (denominator === 1000n && numerator === 997n) {
        // Already the standard Uniswap V2 0.3% fee — no conversion needed.
        feeNum = numerator;
      } else if (numerator >= denominator) {
        feeNum = BPS_DENOM - 30n; // safe default: 0.3%
      }

      result = simulateV2Swap(state, amountIn, edge.zeroForOne, feeNum, denominator);
      break;
    }
    case "V3": {
      // edge.fee is protocol-native: pips (1e6 = 100%) for V3, but Kyber
      // Elastic factories emit fee-units (1e5 = 100%). simulateV3Swap expects
      // pips, so scale Elastic fees up 10x or the fee is underestimated 10x.
      let feePips = edge.fee != null ? Number(edge.fee) : undefined;
      if (feePips != null && edge.protocol.toUpperCase().includes("ELASTIC")) {
        feePips *= 10;
      }
      result = extractGasResult(simulateV3Swap(state, amountIn, edge.zeroForOne, feePips));
      break;
    }
    case "V4": {
      let feePips = edge.fee != null ? Number(edge.fee) : undefined;
      const v4 = simulateV4Swap(state, amountIn, edge.zeroForOne, feePips);
      if (v4.rejectedReason) {
        throw new Error(`V4 swap rejected: ${v4.rejectedReason}`);
      }
      result = extractGasResult(v4);
      break;
    }
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

function extractGasResult(r: {
  amountOut: bigint;
  gasEstimate: number;
  shallow?: boolean;
  maxReliableAmountIn?: bigint;
}): SimulatedHopResult {
  return {
    amountOut: r.amountOut,
    gasEstimate: r.gasEstimate,
    shallow: r.shallow,
    maxReliableAmountIn: r.maxReliableAmountIn,
  };
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

  const simEdges = prebuiltSimEdges ?? buildSimulationEdges(edges, stateCache, overlay);
  if (!simEdges) throw new Error("Missing state for simulation");

  for (let i = 0; i < simEdges.length; i++) {
    const simEdge = simEdges[i];

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

  const simEdges = prebuiltSimEdges ?? buildSimulationEdges(edges, stateCache, overlay);
  if (!simEdges) throw new Error("Missing state for simulation");

  for (let i = 0; i < simEdges.length; i++) {
    const simEdge = simEdges[i];

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
  overrideStore?: PendingOverrideStore,
): SimulationEdge[] | null {
  const simEdges: SimulationEdge[] = new Array(edges.length);

  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    const poolAddr = edge.poolAddress;
    const baseState = stateCache.get(poolAddr) ?? (edge.stateRef as PoolState | undefined);
    if (!baseState) {
      // console.warn(`Missing base state for pool ${poolAddr}`);
      return null;
    }
    const state = getProjectedPoolState(poolAddr, baseState, overlay, overrideStore);

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
  v3ShallowMaxImpactBps?: number,
): { success: boolean; profit: bigint; totalGas: number; amountOut: bigint } {
  const simEdges = prebuiltSimEdges ?? buildSimulationEdges(edges, stateCache, overlay);
  if (!simEdges) throw new Error("Missing state for simulation");
  let currentAmount = amountIn;
  let totalGas = 0;

  for (let i = 0; i < simEdges.length; i++) {
    const simEdge = simEdges[i];
    const state = simEdge.stateRef;

    const hop = simulateHop(simEdge, currentAmount, stateCache, overlay);
    if (state) {
      const realizedPrice = Number(hop.amountOut) / Number(currentAmount);
      const spotPrice = computeSpotPrice(simEdge.normalizedProtocol, simEdge.zeroForOne, simEdge.tokenInIdx, simEdge.tokenOutIdx, state);
      if (spotPrice > 0) {
        const impact = (spotPrice - realizedPrice) / spotPrice;
        const threshold = effectiveImpactThreshold(
          simEdge.normalizedProtocol,
          state,
          maxImpactThreshold,
          v3ShallowMaxImpactBps,
        );
        if (impact > threshold) return { success: false, profit: 0n, totalGas: 0, amountOut: 0n };
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
