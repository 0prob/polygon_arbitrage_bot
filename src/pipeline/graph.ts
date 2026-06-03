import type { Address } from "../core/types/common.ts";
import type { PoolMeta } from "../core/types/pool.ts";
import type { SwapEdge, RoutingGraph } from "./types.ts";
import { DEFAULT_FEE_BPS } from "./types.ts";
import { isGarbagePool } from "../core/constants.ts";

/**
 * Creates the bidirectional SwapEdge entries for a single pool.
 * Shared by buildGraph (full) and IncrementalGraphUpdater.addNewPool to avoid
 * duplicated edge-generation logic (and risk of drift in zeroForOne/idx/fee handling).
 */
export function createEdgesForPool(pool: PoolMeta, state: Record<string, unknown> | undefined): SwapEdge[] {
  const edges: SwapEdge[] = [];
  const addr = pool.address.toLowerCase() as Address;
  const t = pool.tokens ?? [];
  const feeBps = pool.fee != null ? BigInt(pool.fee) : DEFAULT_FEE_BPS;
  for (let i = 0; i < t.length; i++) {
    const tILower = t[i].toLowerCase() as Address;
    for (let j = 0; j < t.length; j++) {
      if (i === j) continue;
      const tJLower = t[j].toLowerCase() as Address;
      edges.push({
        poolAddress: addr,
        protocol: pool.protocol,
        tokenIn: tILower,
        tokenOut: tJLower,
        feeBps,
        stateRef: state,
        zeroForOne: i < j,
        tokenInIdx: i,
        tokenOutIdx: j,
      });
    }
  }
  return edges;
}

export function buildGraph(pools: PoolMeta[], stateCache: Map<string, unknown>): RoutingGraph {
  // Final safety net: drop any garbage pools that somehow made it this far
  // (e.g. historical data from before the indexer filter, or bad static anchors).
  const cleanPools = pools.filter((p) => !isGarbagePool(p));

  const adjacency = new Map<string, SwapEdge[]>();
  const poolMeta = new Map<string, PoolMeta>();
  const stateRefs = new Map<string, unknown>();
  const tokens = new Set<string>();
  for (const pool of cleanPools) {
    const addr = pool.address.toLowerCase();
    poolMeta.set(addr, pool);
    const state = stateCache.get(addr) as Record<string, unknown> | undefined;
    stateRefs.set(addr, state);
    const t = pool.tokens ?? [];
    for (let i = 0; i < t.length; i++) {
      const tILower = t[i].toLowerCase();
      tokens.add(tILower);
    }
    const poolEdges = createEdgesForPool(pool, state);
    for (const edge of poolEdges) {
      const from = edge.tokenIn; // already lowercased Address
      if (!adjacency.has(from)) adjacency.set(from, []);
      adjacency.get(from)!.push(edge);
    }
  }
  return { adjacency, poolMeta, stateRefs, tokens };
}
