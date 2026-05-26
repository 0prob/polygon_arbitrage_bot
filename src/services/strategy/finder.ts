import type { Address } from "../../core/types/common.ts";
import type { RoutingGraph, SwapEdge } from "./graph.ts";

export type { SwapEdge };

export interface FoundCycle {
  startToken: Address;
  edges: SwapEdge[];
  hopCount: number;
  logWeight: number;
  cumulativeFeeBps: bigint;
}

export function routeKeyFromEdges(edges: SwapEdge[], startToken: Address): string {
  const parts = edges.map((e) => e.poolAddress.toLowerCase()).sort();
  parts.push(startToken.toLowerCase());
  return parts.join(":");
}

function feeLogWeight(feeBps: bigint): number {
  const feeNum = Math.min(Number(feeBps), 9999);
  const factor = Math.max(1, 10000 - feeNum) / 10000;
  return -Math.log(factor);
}

export function scoreCycleWithFeedback(logWeight: number, routeKey: string, getWinRate: (key: string) => number): number {
  const winRate = getWinRate(routeKey);
  if (winRate <= 0) return logWeight;
  const feedbackBonus = Math.log(1 + 10 * winRate);
  return logWeight - feedbackBonus;
}

const MAX_CYCLES_PER_PASS = 250_000;

export function findCycles(graph: RoutingGraph, maxHops: number, maxCycles: number = MAX_CYCLES_PER_PASS): FoundCycle[] {
  const cycles: FoundCycle[] = [];
  const hopLimit = Math.min(maxHops, 8);
  const { adjacency } = graph;

  // Pre-filter adjacency to skip empty or dead tokens
  const activeAdjacency = new Map<string, SwapEdge[]>();
  for (const [token, edges] of adjacency) {
    if (edges.length > 0) activeAdjacency.set(token, edges);
  }

  for (const [startToken, firstEdges] of activeAdjacency) {
    if (cycles.length >= maxCycles) break;

    // BFS/DFS with hop tracking is more flexible, but for performance 
    // we keep unrolled loops for common cases (2, 3 hops)
    
    // ── 2-hop: A → B → A ─────────────────────────────────────────
    for (const e1 of firstEdges) {
      if (cycles.length >= maxCycles) break;
      const second = activeAdjacency.get(e1.tokenOut);
      if (!second) continue;

      for (const e2 of second) {
        if (e2.tokenOut !== startToken) continue;
        if (e2.poolAddress === e1.poolAddress) continue;
        
        cycles.push({
          startToken: startToken as Address,
          edges: [e1, e2],
          hopCount: 2,
          logWeight: feeLogWeight(e1.feeBps) + feeLogWeight(e2.feeBps),
          cumulativeFeeBps: e1.feeBps + e2.feeBps,
        });
      }
    }

    if (hopLimit < 3 || cycles.length >= maxCycles) continue;

    // ── 3-hop: A → B → C → A ─────────────────────────────────────
    for (const e1 of firstEdges) {
      if (cycles.length >= maxCycles) break;
      const second = activeAdjacency.get(e1.tokenOut);
      if (!second) continue;

      for (const e2 of second) {
        if (e2.tokenOut === startToken) continue;
        if (e2.poolAddress === e1.poolAddress) continue;
        const third = activeAdjacency.get(e2.tokenOut);
        if (!third) continue;

        for (const e3 of third) {
          if (e3.tokenOut !== startToken) continue;
          if (e3.poolAddress === e1.poolAddress || e3.poolAddress === e2.poolAddress) continue;

          cycles.push({
            startToken: startToken as Address,
            edges: [e1, e2, e3],
            hopCount: 3,
            logWeight: feeLogWeight(e1.feeBps) + feeLogWeight(e2.feeBps) + feeLogWeight(e3.feeBps),
            cumulativeFeeBps: e1.feeBps + e2.feeBps + e3.feeBps,
          });
        }
      }
    }

    if (hopLimit < 4 || cycles.length >= maxCycles) continue;

    // ── 4-hop: A → B → C → D → A (Selective high-quality search) ────
    for (const e1 of firstEdges) {
      if (cycles.length >= maxCycles) break;
      const second = activeAdjacency.get(e1.tokenOut);
      if (!second) continue;

      for (const e2 of second) {
        if (e2.tokenOut === startToken) continue;
        if (e2.poolAddress === e1.poolAddress) continue;
        const third = activeAdjacency.get(e2.tokenOut);
        if (!third) continue;

        for (const e3 of third) {
          if (e3.tokenOut === startToken) continue;
          if (e3.poolAddress === e1.poolAddress || e3.poolAddress === e2.poolAddress) continue;
          const fourth = activeAdjacency.get(e3.tokenOut);
          if (!fourth) continue;

          for (const e4 of fourth) {
            if (e4.tokenOut !== startToken) continue;
            if (e4.poolAddress === e1.poolAddress || e4.poolAddress === e2.poolAddress || e4.poolAddress === e3.poolAddress) continue;

            cycles.push({
              startToken: startToken as Address,
              edges: [e1, e2, e3, e4],
              hopCount: 4,
              logWeight: feeLogWeight(e1.feeBps) + feeLogWeight(e2.feeBps) + feeLogWeight(e3.feeBps) + feeLogWeight(e4.feeBps),
              cumulativeFeeBps: e1.feeBps + e2.feeBps + e3.feeBps + e4.feeBps,
            });
          }
        }
      }
    }
  }

  return cycles;
}

export function enumerateCycles(
  graph: RoutingGraph,
  maxHops = 4,
  maxCycles = MAX_CYCLES_PER_PASS,
  getWinRate?: (key: string) => number,
): FoundCycle[] {
  const allCycles = findCycles(graph, maxHops, maxCycles);
  
  if (getWinRate) {
    // Pre-compute scores to avoid O(N log N) string manipulation in sort
    const scored = allCycles.map(cycle => {
      const key = routeKeyFromEdges(cycle.edges, cycle.startToken);
      const score = scoreCycleWithFeedback(cycle.logWeight, key, getWinRate);
      return { cycle, score };
    });

    return scored
      .sort((a, b) => a.score - b.score)
      .slice(0, maxCycles)
      .map(s => s.cycle);
  }

  return allCycles.sort((a, b) => a.logWeight - b.logWeight).slice(0, maxCycles);
}
