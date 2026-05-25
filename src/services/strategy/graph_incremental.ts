import type { RoutingGraph, SwapEdge } from "./graph.ts";
import type { PoolMeta } from "../../core/types/pool.ts";
import type { Address } from "../../core/types/common.ts";

const DEFAULT_FEE_BPS = 30n;

export class IncrementalGraphUpdater {
  private fullRebuildCount = 0;

  constructor(
    private readonly fullRebuildInterval: number = 60,
  ) {}

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
    graph.poolMeta.forEach((meta, key) => {
      if (key.toLowerCase() === addr) {
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
    });
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

    for (let i = 0; i < t.length; i++) {
      const tILower = t[i].toLowerCase();
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
        if (!graph.adjacency.has(tILower)) {
          graph.adjacency.set(tILower, []);
        }
        graph.adjacency.get(tILower)!.push(edge);
      }
    }
  }

  removePool(graph: RoutingGraph, poolAddress: string): void {
    const addr = poolAddress.toLowerCase();
    graph.poolMeta.delete(addr);
    graph.stateRefs.delete(addr);

    for (const [token, edges] of graph.adjacency) {
      const filtered = edges.filter(e => e.poolAddress.toLowerCase() !== addr);
      if (filtered.length === 0) {
        graph.adjacency.delete(token);
      } else {
        graph.adjacency.set(token, filtered);
      }
    }
  }
}
