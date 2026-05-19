import type { Address } from "../../core/types/common.ts";
import type { PoolMeta } from "../../core/types/pool.ts";

export interface SwapEdge {
  poolAddress: Address;
  protocol: string;
  tokenIn: Address;
  tokenOut: Address;
  feeBps: bigint;
  stateRef?: unknown;
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
    stateRefs.set(addr, stateCache.get(addr));
    const t = pool.tokens ?? [];
    for (let i = 0; i < t.length; i++) {
      tokens.add(t[i].toLowerCase());
      for (let j = 0; j < t.length; j++) {
        if (i === j) continue;
        const edge: SwapEdge = {
          poolAddress: addr as Address,
          protocol: pool.protocol,
          tokenIn: t[i].toLowerCase() as Address,
          tokenOut: t[j].toLowerCase() as Address,
          feeBps: pool.fee != null ? BigInt(pool.fee) : 30n,
          stateRef: stateRefs.get(addr),
        };
        const k = t[i].toLowerCase();
        if (!adjacency.has(k)) adjacency.set(k, []);
        adjacency.get(k)!.push(edge);
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
