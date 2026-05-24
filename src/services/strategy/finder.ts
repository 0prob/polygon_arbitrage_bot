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

export function scoreCycleWithFeedback(
  logWeight: number,
  routeKey: string,
  getWinRate: (key: string) => number,
): number {
  const winRate = getWinRate(routeKey);
  if (winRate <= 0) return logWeight;
  const feedbackBonus = Math.log(1 + 10 * winRate);
  return logWeight - feedbackBonus;
}

const MAX_CYCLES_PER_PASS = 250_000;

export function findCycles(
  graph: RoutingGraph,
  maxHops: number,
  maxCycles: number = MAX_CYCLES_PER_PASS,
): FoundCycle[] {
  const cycles: FoundCycle[] = [];
  const hopLimit = maxHops > 4 ? 4 : maxHops;
  const { adjacency } = graph;

  for (const [startToken, firstEdges] of adjacency) {
    if (cycles.length >= maxCycles) break;
    const out1 = firstEdges;
    const o1len = out1.length;
    if (o1len === 0) continue;

    // ── 2-hop: A → B → A ─────────────────────────────────────────
    for (let i = 0; i < o1len && cycles.length < maxCycles; i++) {
      const e1 = out1[i];
      const second = adjacency.get(e1.tokenOut.toLowerCase());
      if (!second) continue;
      const out2 = second;
      const o2len = out2.length;
      const w2 = feeLogWeight(e1.feeBps);
      const cf2 = e1.feeBps;
      for (let j = 0; j < o2len && cycles.length < maxCycles; j++) {
        const e2 = out2[j];
        if (e2.tokenOut.toLowerCase() !== startToken) continue;
        cycles.push({
          startToken: startToken as Address,
          edges: [e1, e2],
          hopCount: 2,
          logWeight: w2 + feeLogWeight(e2.feeBps),
          cumulativeFeeBps: cf2 + e2.feeBps,
        });
      }
    }

    if (hopLimit < 3 || cycles.length >= maxCycles) continue;

    // ── 3-hop: A → B → C → A ─────────────────────────────────────
    for (let i = 0; i < o1len && cycles.length < maxCycles; i++) {
      const e1 = out1[i];
      const second = adjacency.get(e1.tokenOut.toLowerCase());
      if (!second) continue;
      const out2 = second;
      const o2len = out2.length;
      const w3a = feeLogWeight(e1.feeBps);
      const cf3a = e1.feeBps;
      for (let j = 0; j < o2len && cycles.length < maxCycles; j++) {
        const e2 = out2[j];
        if (e2.tokenOut.toLowerCase() === startToken) continue;
        const third = adjacency.get(e2.tokenOut.toLowerCase());
        if (!third) continue;
        const out3 = third;
        const o3len = out3.length;
        const w3b = w3a + feeLogWeight(e2.feeBps);
        const cf3b = cf3a + e2.feeBps;
        for (let k = 0; k < o3len && cycles.length < maxCycles; k++) {
          const e3 = out3[k];
          if (e3.tokenOut.toLowerCase() !== startToken) continue;
          cycles.push({
            startToken: startToken as Address,
            edges: [e1, e2, e3],
            hopCount: 3,
            logWeight: w3b + feeLogWeight(e3.feeBps),
            cumulativeFeeBps: cf3b + e3.feeBps,
          });
        }
      }
    }

    if (hopLimit < 4 || cycles.length >= maxCycles) continue;

    // ── 4-hop: A → B → C → D → A ─────────────────────────────────
    for (let i = 0; i < o1len && cycles.length < maxCycles; i++) {
      const e1 = out1[i];
      const second = adjacency.get(e1.tokenOut.toLowerCase());
      if (!second) continue;
      const out2 = second;
      const o2len = out2.length;
      const w4a = feeLogWeight(e1.feeBps);
      const cf4a = e1.feeBps;
      for (let j = 0; j < o2len && cycles.length < maxCycles; j++) {
        const e2 = out2[j];
        if (e2.tokenOut.toLowerCase() === startToken) continue;
        const third = adjacency.get(e2.tokenOut.toLowerCase());
        if (!third) continue;
        const out3 = third;
        const o3len = out3.length;
        const w4b = w4a + feeLogWeight(e2.feeBps);
        const cf4b = cf4a + e2.feeBps;
        for (let k = 0; k < o3len && cycles.length < maxCycles; k++) {
          const e3 = out3[k];
          if (e3.tokenOut.toLowerCase() === startToken) continue;
          const fourth = adjacency.get(e3.tokenOut.toLowerCase());
          if (!fourth) continue;
          const out4 = fourth;
          const o4len = out4.length;
          const w4c = w4b + feeLogWeight(e3.feeBps);
          const cf4c = cf4b + e3.feeBps;
          for (let l = 0; l < o4len && cycles.length < maxCycles; l++) {
            const e4 = out4[l];
            if (e4.tokenOut.toLowerCase() !== startToken) continue;
            cycles.push({
              startToken: startToken as Address,
              edges: [e1, e2, e3, e4],
              hopCount: 4,
              logWeight: w4c + feeLogWeight(e4.feeBps),
              cumulativeFeeBps: cf4c + e4.feeBps,
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
    return allCycles
      .sort((a, b) => {
        const keyA = routeKeyFromEdges(a.edges, a.startToken);
        const keyB = routeKeyFromEdges(b.edges, b.startToken);
        const scoreA = scoreCycleWithFeedback(a.logWeight, keyA, getWinRate);
        const scoreB = scoreCycleWithFeedback(b.logWeight, keyB, getWinRate);
        return scoreA - scoreB;
      })
      .slice(0, maxCycles);
  }
  return allCycles.sort((a, b) => a.logWeight - b.logWeight).slice(0, maxCycles);
}
