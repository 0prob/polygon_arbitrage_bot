import type { Address } from "../../core/types/common.ts";
import type { PoolState } from "../../core/types/pool.ts";
import { type RoutingGraph, buildGraph } from "./graph.ts";
import type { PoolMeta } from "../../core/types/pool.ts";

export class GraphManager {
  private _graph: RoutingGraph;

  constructor(pools: PoolMeta[], stateCache: Map<string, unknown>) {
    this._graph = buildGraph(pools, stateCache);
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
