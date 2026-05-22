import type { Address } from "../../core/types/common.ts";
import type { PoolMeta } from "../../core/types/pool.ts";

const DEFAULT_FEE_BPS = 30n;

export interface SwapEdge {
  poolAddress: Address;
  protocol: string;
  tokenIn: Address;
  tokenOut: Address;
  feeBps: bigint;
  stateRef?: unknown;
  // Pre-calculated parameters (optional for test compatibility)
  zeroForOne?: boolean;
  tokenInIdx?: number;
  tokenOutIdx?: number;
}

export interface RoutingGraph {
  adjacency: Map<string, SwapEdge[]>;
  poolMeta: Map<string, PoolMeta>;
  stateRefs: Map<string, unknown>;
  tokens: Set<string>;
}

function inferZeroForOne(edge: { tokenIn: string; tokenOut: string }, state: Record<string, unknown>): boolean {
  const t0 = state.token0;
  if (typeof t0 === "string") return edge.tokenIn === t0.toLowerCase();
  if (Array.isArray(state.tokens)) {
    const tokens = state.tokens as string[];
    const tokenIn = edge.tokenIn;
    return tokens.some((t) => t.toLowerCase() === tokenIn);
  }
  return edge.tokenIn < edge.tokenOut;
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

export function buildGraph(pools: PoolMeta[], stateCache: Map<string, unknown>): RoutingGraph {
  const adjacency = new Map<string, SwapEdge[]>();
  const poolMeta = new Map<string, PoolMeta>();
  const stateRefs = new Map<string, unknown>();
  const tokens = new Set<string>();
  for (const pool of pools) {
    const addr = pool.address.toLowerCase();
    poolMeta.set(addr, pool);
    const state = stateCache.get(addr) as Record<string, unknown> | undefined;
    stateRefs.set(addr, state);
    const t = pool.tokens ?? [];
    for (let i = 0; i < t.length; i++) {
      const tILower = t[i].toLowerCase();
      tokens.add(tILower);
      for (let j = 0; j < t.length; j++) {
        if (i === j) continue;
        const tJLower = t[j].toLowerCase();
        const edge: SwapEdge = {
          poolAddress: addr as Address,
          protocol: pool.protocol,
          tokenIn: tILower as Address,
          tokenOut: tJLower as Address,
          feeBps: pool.fee != null ? BigInt(pool.fee) : DEFAULT_FEE_BPS,
          stateRef: state,
          zeroForOne: state ? inferZeroForOne({ tokenIn: tILower, tokenOut: tJLower }, state) : tILower < tJLower,
          tokenInIdx: state ? inferTokenIdx(tILower, state, 0) : 0,
          tokenOutIdx: state ? inferTokenIdx(tJLower, state, 1) : 1,
        };
        if (!adjacency.has(tILower)) adjacency.set(tILower, []);
        adjacency.get(tILower)!.push(edge);
      }
    }
  }
  return { adjacency, poolMeta, stateRefs, tokens };
}

export function buildHubGraph(pools: PoolMeta[], stateCache: Map<string, unknown>, hubTokens: readonly Address[]): RoutingGraph {
  const hubSet = new Set(hubTokens.map((t) => t.toLowerCase()));
  return buildGraph(
    pools.filter((p) => (p.tokens ?? []).some((t) => hubSet.has(t.toLowerCase()))),
    stateCache,
  );
}
