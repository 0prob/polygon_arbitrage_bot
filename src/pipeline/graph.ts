import type { Address } from "../core/types/common.ts";
import type { PoolMeta } from "../core/types/pool.ts";
import type { SwapEdge, RoutingGraph } from "./types.ts";
import { DEFAULT_FEE_BPS } from "./types.ts";
import { isGarbagePool } from "../core/constants.ts";

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
