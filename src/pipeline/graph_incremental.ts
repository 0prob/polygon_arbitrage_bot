import type { RoutingGraph } from "./types.ts";
import type { PoolMeta } from "../core/types/pool.ts";
import { createEdgesForPool } from "./graph.ts";

export class IncrementalGraphUpdater {
  private fullRebuildCount = 0;

  constructor(private readonly fullRebuildInterval: number = 60) {}

  getFullRebuildCount(): number {
    return this.fullRebuildCount;
  }

  shouldFullRebuild(): boolean {
    this.fullRebuildCount++;
    return this.fullRebuildCount % this.fullRebuildInterval === 0;
  }

  resetRebuildCounter(): void {
    this.fullRebuildCount = 0;
  }

  applyPoolStateUpdate(graph: RoutingGraph, poolAddress: string, newState: Record<string, unknown>): void {
    const addr = poolAddress.toLowerCase();
    graph.stateRefs.set(addr, newState);
    // O(1) Map lookup instead of O(N) forEach scan — poolMeta keys are already lowercased
    const meta = graph.poolMeta.get(addr);
    if (meta) {
      const t = meta.tokens ?? [];
      for (const token of t) {
        const edges = graph.adjacency.get(token.toLowerCase());
        if (edges) {
          for (const edge of edges) {
            if (edge.poolAddress.toLowerCase() === addr) {
              edge.stateRef = newState;
            }
          }
        }
      }
    }
  }

  addNewPool(graph: RoutingGraph, pool: PoolMeta, state: Record<string, unknown>): void {
    const addr = pool.address.toLowerCase();
    graph.poolMeta.set(addr, pool);
    graph.stateRefs.set(addr, state);

    const t = pool.tokens ?? [];
    for (const token of t) {
      const tLower = token.toLowerCase();
      graph.tokens.add(tLower);
    }

    const poolEdges = createEdgesForPool(pool, state);
    for (const edge of poolEdges) {
      const tILower = edge.tokenIn;
      if (!graph.adjacency.has(tILower)) {
        graph.adjacency.set(tILower, []);
      }
      graph.adjacency.get(tILower)!.push(edge);
    }
  }

  removePool(graph: RoutingGraph, poolAddress: string): void {
    const addr = poolAddress.toLowerCase();
    const meta = graph.poolMeta.get(addr);
    graph.poolMeta.delete(addr);
    graph.stateRefs.delete(addr);

    if (meta && meta.tokens) {
      for (const token of meta.tokens) {
        const tLower = token.toLowerCase();
        const edges = graph.adjacency.get(tLower);
        if (edges) {
          const filtered = edges.filter((e) => e.poolAddress.toLowerCase() !== addr);
          if (filtered.length === 0) {
            graph.adjacency.delete(tLower);
          } else {
            graph.adjacency.set(tLower, filtered);
          }
        }
      }
    } else {
      // Fallback in case metadata is missing
      for (const [token, edges] of graph.adjacency) {
        const filtered = edges.filter((e) => e.poolAddress.toLowerCase() !== addr);
        if (filtered.length === 0) {
          graph.adjacency.delete(token);
        } else {
          graph.adjacency.set(token, filtered);
        }
      }
    }
  }
}
