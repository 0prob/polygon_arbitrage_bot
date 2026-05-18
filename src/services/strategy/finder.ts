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

function find2HopCycles(graph: RoutingGraph): FoundCycle[] {
  const cycles: FoundCycle[] = [];
  for (const [tokenIn, outEdges] of graph.adjacency) {
    for (const e1 of outEdges) {
      const inEdges = graph.adjacency.get(e1.tokenOut.toLowerCase());
      if (!inEdges) continue;
      for (const e2 of inEdges) {
        if (e2.tokenOut.toLowerCase() !== tokenIn) continue;
        cycles.push({
          startToken: tokenIn as Address, edges: [e1, e2], hopCount: 2,
          logWeight: feeLogWeight(e1.feeBps) + feeLogWeight(e2.feeBps),
          cumulativeFeeBps: e1.feeBps + e2.feeBps,
        });
      }
    }
  }
  return cycles;
}

function find3HopCycles(graph: RoutingGraph): FoundCycle[] {
  const cycles: FoundCycle[] = [];
  for (const [startToken, firstEdges] of graph.adjacency) {
    for (const e1 of firstEdges) {
      const second = graph.adjacency.get(e1.tokenOut.toLowerCase());
      if (!second) continue;
      for (const e2 of second) {
        if (e2.tokenOut.toLowerCase() === startToken) continue;
        const third = graph.adjacency.get(e2.tokenOut.toLowerCase());
        if (!third) continue;
        for (const e3 of third) {
          if (e3.tokenOut.toLowerCase() !== startToken) continue;
          cycles.push({
            startToken: startToken as Address, edges: [e1, e2, e3], hopCount: 3,
            logWeight: feeLogWeight(e1.feeBps) + feeLogWeight(e2.feeBps) + feeLogWeight(e3.feeBps),
            cumulativeFeeBps: e1.feeBps + e2.feeBps + e3.feeBps,
          });
        }
      }
    }
  }
  return cycles;
}

export function enumerateCycles(graph: RoutingGraph, maxHops = 4): FoundCycle[] {
  const cycles: FoundCycle[] = [];
  if (maxHops >= 2) cycles.push(...find2HopCycles(graph));
  if (maxHops >= 3) cycles.push(...find3HopCycles(graph));
  return cycles;
}
