import type { RoutingGraph } from "./types.ts";
import type { PoolMeta } from "../core/types/pool.ts";
import type { RouteStateCache } from "../core/types/route.ts";
import { createEdgesForPool } from "./graph.ts";
import { normalizeAddress, normalizePoolAddress } from "../core/utils/normalize.ts";

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
    const addr = normalizePoolAddress(poolAddress);
    graph.stateRefs.set(addr, newState);
    // O(1) Map lookup instead of O(N) forEach scan — poolMeta keys are already lowercased
    const meta = graph.poolMeta.get(addr);
    if (meta) {
      const t = meta.tokens ?? [];
      for (const token of t) {
        const edges = graph.adjacency.get(normalizeAddress(token));
        if (edges) {
          for (const edge of edges) {
            if (edge.poolAddress === addr) {
              edge.stateRef = newState;
            }
          }
        }
      }
    }
  }

  addNewPool(graph: RoutingGraph, pool: PoolMeta, state: Record<string, unknown>): void {
    const addr = normalizePoolAddress(pool.address);
    graph.poolMeta.set(addr, pool);
    graph.stateRefs.set(addr, state);

    const t = pool.tokens ?? [];
    for (const token of t) {
      const tLower = normalizeAddress(token);
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
    const addr = normalizePoolAddress(poolAddress);
    const meta = graph.poolMeta.get(addr);
    graph.poolMeta.delete(addr);
    graph.stateRefs.delete(addr);

    if (meta?.tokens) {
      for (const token of meta.tokens) {
        const tLower = normalizeAddress(token);
        const edges = graph.adjacency.get(tLower);
        if (edges) {
          const filtered = edges.filter((e) => e.poolAddress !== addr);
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
        const filtered = edges.filter((e) => e.poolAddress !== addr);
        if (filtered.length === 0) {
          graph.adjacency.delete(token);
        } else {
          graph.adjacency.set(token, filtered);
        }
      }
    }
  }
}

/** Refresh graph.stateRefs and edge.stateRef from the live state cache (head refresh / incremental LF). */
export function syncGraphStateFromCache(
  graph: RoutingGraph,
  pools: Array<{ address: string }>,
  stateCache: RouteStateCache,
  updater: IncrementalGraphUpdater,
): number {
  let updated = 0;
  for (const pool of pools) {
    const addr = normalizePoolAddress(pool.address);
    const state = stateCache.get(addr);
    if (state) {
      updater.applyPoolStateUpdate(graph, addr, state);
      updated++;
    }
  }
  return updated;
}
