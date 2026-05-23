import type { Address } from "../../core/types/common.ts";
import type { PoolState } from "../../core/types/pool.ts";
import { type RoutingGraph, type SwapEdge, buildGraph } from "./graph.ts";
import type { PoolMeta } from "../../core/types/pool.ts";

export class GraphManager {
  private _graph: RoutingGraph;

  constructor(pools: PoolMeta[], stateCache: Map<string, unknown>) {
    this._graph = buildGraph(pools, stateCache);
  }

  addPool(pool: PoolMeta, state: unknown): void {
    const addr = pool.address.toLowerCase();
    
    if (this._graph.poolMeta.has(addr)) return;

    this._graph.poolMeta.set(addr, pool);
    this._graph.stateRefs.set(addr, state);

    const t = pool.tokens ?? [];
    const DEFAULT_FEE_BPS = 30n;
    for (let i = 0; i < t.length; i++) {
      const tILower = t[i].toLowerCase();
      this._graph.tokens.add(tILower);
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
        if (!this._graph.adjacency.has(tILower)) this._graph.adjacency.set(tILower, []);
        this._graph.adjacency.get(tILower)!.push(edge);
      }
    }
  }

  updatePool(address: Address, state: PoolState): void {
    const addr = address.toLowerCase();
    this._graph.stateRefs.set(addr, state);
    
    // Iterate through adjacency to update relevant edges
    for (const [_, edges] of this._graph.adjacency) {
      for (const edge of edges) {
        if (edge.poolAddress.toLowerCase() === addr) {
          edge.stateRef = state;
        }
      }
    }
  }

  get graph(): RoutingGraph {
    return this._graph;
  }
}
