import type { Address } from "../../core/types/common.ts";
import type { RoutingGraph, SwapEdge } from "./graph.ts";
import { HUB_4_TOKENS } from "../../config/addresses.ts";

export type { SwapEdge };

export interface FoundCycle {
  startToken: Address;
  edges: SwapEdge[];
  hopCount: number;
  logWeight: number;
  cumulativeFeeBps: bigint;
}

const HUB_SET = new Set(HUB_4_TOKENS.map((t) => t.toLowerCase()));

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

const MAX_CYCLES_PER_PASS = 100_000;

export function find2HopCycles(graph: RoutingGraph, maxCycles: number = MAX_CYCLES_PER_PASS): FoundCycle[] {
  const cycles: FoundCycle[] = [];
  for (const [tokenIn, outEdges] of graph.adjacency) {
    if (cycles.length >= maxCycles) break;
    for (const e1 of outEdges) {
      if (cycles.length >= maxCycles) break;
      const inEdges = graph.adjacency.get(e1.tokenOut.toLowerCase());
      if (!inEdges) continue;
      for (const e2 of inEdges) {
        if (cycles.length >= maxCycles) break;
        if (e2.tokenOut.toLowerCase() !== tokenIn) continue;
        cycles.push({
          startToken: tokenIn as Address,
          edges: [e1, e2],
          hopCount: 2,
          logWeight: feeLogWeight(e1.feeBps) + feeLogWeight(e2.feeBps),
          cumulativeFeeBps: e1.feeBps + e2.feeBps,
        });
      }
    }
  }
  return cycles;
}

export function find3HopCycles(graph: RoutingGraph, maxCycles: number = MAX_CYCLES_PER_PASS): FoundCycle[] {
  const cycles: FoundCycle[] = [];
  for (const [startToken, firstEdges] of graph.adjacency) {
    if (cycles.length >= maxCycles) break;
    for (const e1 of firstEdges) {
      if (cycles.length >= maxCycles) break;
      const second = graph.adjacency.get(e1.tokenOut.toLowerCase());
      if (!second) continue;
      for (const e2 of second) {
        if (cycles.length >= maxCycles) break;
        if (e2.tokenOut.toLowerCase() === startToken) continue;
        const third = graph.adjacency.get(e2.tokenOut.toLowerCase());
        if (!third) continue;
        for (const e3 of third) {
          if (cycles.length >= maxCycles) break;
          if (e3.tokenOut.toLowerCase() !== startToken) continue;
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
  }
  return cycles;
}

export function find4HopCycles(graph: RoutingGraph, maxCycles: number = MAX_CYCLES_PER_PASS): FoundCycle[] {
  const cycles: FoundCycle[] = [];
  for (const [startToken, firstEdges] of graph.adjacency) {
    if (cycles.length >= maxCycles) break;
    if (!HUB_SET.has(startToken)) continue;

    for (const e1 of firstEdges) {
      if (cycles.length >= maxCycles) break;
      const second = graph.adjacency.get(e1.tokenOut.toLowerCase());
      if (!second) continue;
      for (const e2 of second) {
        if (cycles.length >= maxCycles) break;
        if (e2.tokenOut.toLowerCase() === startToken) continue;
        const third = graph.adjacency.get(e2.tokenOut.toLowerCase());
        if (!third) continue;
        for (const e3 of third) {
          if (cycles.length >= maxCycles) break;
          if (e3.tokenOut.toLowerCase() === startToken) continue;
          const fourth = graph.adjacency.get(e3.tokenOut.toLowerCase());
          if (!fourth) continue;
          for (const e4 of fourth) {
            if (cycles.length >= maxCycles) break;
            if (e4.tokenOut.toLowerCase() !== startToken) continue;
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

export function enumerateCycles(graph: RoutingGraph, maxHops = 4, maxCycles = MAX_CYCLES_PER_PASS): FoundCycle[] {
  let allCycles: FoundCycle[] = [];

  // Allocate budget roughly: 40% to 2-hop, 40% to 3-hop, 20% to 4-hop
  // But always try to fill the total maxCycles
  const limits = {
    2: Math.floor(maxCycles * 0.4),
    3: Math.floor(maxCycles * 0.4),
    4: Math.floor(maxCycles * 0.2),
  };

  if (maxHops >= 2) allCycles.push(...find2HopCycles(graph, limits[2]));
  if (maxHops >= 3) allCycles.push(...find3HopCycles(graph, limits[3]));
  if (maxHops >= 4) allCycles.push(...find4HopCycles(graph, limits[4]));

  // Sort by logWeight (ascending, as it represents -log(1-fee), so smaller is better)
  return allCycles.sort((a, b) => a.logWeight - b.logWeight).slice(0, maxCycles);
}
