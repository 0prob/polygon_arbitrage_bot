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
  // Pre-calculated parameters
  zeroForOne: boolean;
  tokenInIdx: number;
  tokenOutIdx: number;
}

export interface RoutingGraph {
  adjacency: Map<string, SwapEdge[]>;
  poolMeta: Map<string, PoolMeta>;
  stateRefs: Map<string, unknown>;
  tokens: Set<string>;
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
          zeroForOne: i < j,
          tokenInIdx: i,
          tokenOutIdx: j,
        };
        if (!adjacency.has(tILower)) adjacency.set(tILower, []);
        adjacency.get(tILower)!.push(edge);
      }
    }
  }
  return { adjacency, poolMeta, stateRefs, tokens };
}
