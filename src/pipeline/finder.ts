import type { Address } from "../core/types/common.ts";
import type { RoutingGraph, SwapEdge, FoundCycle } from "./types.ts";
import * as os from "os";

export function routeKeyFromEdges(edges: SwapEdge[], startToken: Address): string {
  const parts = edges.map((e) => e.poolAddress.toLowerCase()).sort();
  parts.push(startToken.toLowerCase());
  return parts.join(":");
}

export function averageObscurity(edges: SwapEdge[]): number {
  if (!edges.length) return 0;
  let sum = 0;
  for (const e of edges) sum += getObscurityBonus(e.protocol);
  return sum / edges.length;
}

function feeLogWeight(feeBps: bigint): number {
  const feeNum = Math.min(Number(feeBps), 9999);
  const factor = Math.max(1, 10000 - feeNum) / 10000;
  return -Math.log(factor);
}

/**
 * Obscurity / low-competition bonus for edges.
 *
 * With minimal infra (public RPCs, standard latency), the bot cannot win
 * pure speed races on hot mainstream V3 pairs against specialized bots.
 *
 * Strategy: heavily favor paths through less-watched protocols and factories
 * where:
 *   - Pricing models are more complex (DODO PMM, Curve stables, Balancer weighted)
 *   - Fewer arbers are running full multi-AMM simulation
 *   - Opportunities persist longer (thinner liquidity rebalances slowly)
 *
 * These are exactly the areas where this bot's strengths (rich math coverage
 * + HyperIndex historical state + broad V2 factory coverage) give it an edge.
 */
export function getObscurityBonus(protocol: string): number {
  const p = (protocol || "").toLowerCase();

  // Highest priority long-tail / low-competition
  // Note: This logic assumes the indexer is running in broad discovery mode
  // (INDEXER_HOT_BIAS=false). Hot-bias mode in the indexer will starve this logic
  // of the obscure pools it is designed to favor.
  if (p.includes("dfyn") || p.includes("ape") || p.includes("mesh") || p.includes("jet") || p.includes("cometh")) {
    return 1.4; // very obscure V2 factories
  }
  if (p.includes("dodo")) return 1.25;
  if (p.includes("balancer")) return 1.1;
  if (p.includes("curve")) return 1.0;
  if (p.includes("woofi")) return 0.9;

  // Mainstream high-competition (de-prioritize for speed races)
  if (p.includes("uniswap")) return 0.15;
  if (p.includes("quickswap") && !p.includes("_v2")) return 0.25; // V3 quickswap is competitive
  if (p.includes("sushiswap") && !p.includes("_v2")) return 0.3;

  // Other V2s are medium (still better than hot V3 usually)
  if (p.includes("_v2")) return 0.7;

  return 0.5; // default mild bonus for anything non-pure-mainstream
}

function cycleObscurityBonus(edges: SwapEdge[]): number {
  if (!edges.length) return 0;
  let sum = 0;
  for (const e of edges) {
    sum += getObscurityBonus(e.protocol);
  }
  return sum / edges.length;
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
  const hopLimit = Math.min(maxHops, 6); // Cap at 6 for safety; 5 is the practical increase for discovery
  const { adjacency } = graph;

  // Hardware protection: time + load budget so we don't melt the CPU or lock the system
  const ENUM_START = Date.now();
  const TIME_BUDGET_MS = 1400; // ~1.4s hard stop — safe on most dev/laptop hardware during LF pass
  try {
    const load = os.loadavg()[0];
    if (load > 7.5) {
      // High load — be conservative, fall back toward 4 hops behavior
      // (the if guards below will still allow 5 if user explicitly set high maxHops, but we won't push as hard)
      console.warn?.(`[finder] High system load (${load.toFixed(1)}), enumeration will be time-capped aggressively`);
    }
  } catch {}

  function overBudget(): boolean {
    if (Date.now() - ENUM_START > TIME_BUDGET_MS) {
      return true;
    }
    if (cycles.length >= maxCycles) return true;
    return false;
  }

  // Pre-filter adjacency to skip empty or dead tokens
  const activeAdjacency = new Map<string, SwapEdge[]>();
  for (const [token, edges] of adjacency) {
    if (edges.length > 0) activeAdjacency.set(token, edges);
  }

  for (const [startToken, firstEdges] of activeAdjacency) {
    if (overBudget()) break;
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

        const obs = cycleObscurityBonus([e1, e2]);
        // Long-tail boost: subtract from logWeight so obscure cycles sort as "better" (lower logWeight first)
        cycles.push({
          startToken: startToken as Address,
          edges: [e1, e2],
          hopCount: 2,
          logWeight: feeLogWeight(e1.feeBps) + feeLogWeight(e2.feeBps) - obs * 0.8,
          cumulativeFeeBps: e1.feeBps + e2.feeBps,
        });
      }
    }

    if (hopLimit < 3 || overBudget()) continue;

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

          const obs = cycleObscurityBonus([e1, e2, e3]);
          cycles.push({
            startToken: startToken as Address,
            edges: [e1, e2, e3],
            hopCount: 3,
            logWeight: feeLogWeight(e1.feeBps) + feeLogWeight(e2.feeBps) + feeLogWeight(e3.feeBps) - obs * 1.1,
            cumulativeFeeBps: e1.feeBps + e2.feeBps + e3.feeBps,
          });
        }
      }
    }

    if (hopLimit < 4 || overBudget()) continue;

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

            const obs = cycleObscurityBonus([e1, e2, e3, e4]);
            cycles.push({
              startToken: startToken as Address,
              edges: [e1, e2, e3, e4],
              hopCount: 4,
              logWeight: feeLogWeight(e1.feeBps) + feeLogWeight(e2.feeBps) + feeLogWeight(e3.feeBps) + feeLogWeight(e4.feeBps) - obs * 1.4,
              cumulativeFeeBps: e1.feeBps + e2.feeBps + e3.feeBps + e4.feeBps,
            });
          }
        }
      }
    }

    if (hopLimit < 5 || overBudget()) continue;

    // ── 5-hop: A → B → C → D → E → A  (Long-tail discovery boost) ───
    // Increasing to 5 hops significantly expands opportunity space into
    // complex cross-protocol paths (esp. obscure V2 + DODO/Curve/Balancer)
    // that lower-hop bots miss. Guarded by cycle cap + time budget below.
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
            if (e4.tokenOut === startToken) continue;
            if (e4.poolAddress === e1.poolAddress || e4.poolAddress === e2.poolAddress || e4.poolAddress === e3.poolAddress) continue;
            const fifth = activeAdjacency.get(e4.tokenOut);
            if (!fifth) continue;

            for (const e5 of fifth) {
              if (e5.tokenOut !== startToken) continue;
              if (
                e5.poolAddress === e1.poolAddress ||
                e5.poolAddress === e2.poolAddress ||
                e5.poolAddress === e3.poolAddress ||
                e5.poolAddress === e4.poolAddress
              )
                continue;

              const obs = cycleObscurityBonus([e1, e2, e3, e4, e5]);
              // Even stronger long-tail preference for 5-hop obscure paths
              cycles.push({
                startToken: startToken as Address,
                edges: [e1, e2, e3, e4, e5],
                hopCount: 5,
                logWeight:
                  feeLogWeight(e1.feeBps) +
                  feeLogWeight(e2.feeBps) +
                  feeLogWeight(e3.feeBps) +
                  feeLogWeight(e4.feeBps) +
                  feeLogWeight(e5.feeBps) -
                  obs * 1.7,
                cumulativeFeeBps: e1.feeBps + e2.feeBps + e3.feeBps + e4.feeBps + e5.feeBps,
              });
            }
          }
        }
      }
    }
  }

  if (overBudget() && cycles.length > 0) {
    // Silent for normal operation; the caller will log total cycles found
  }

  return cycles;
}

export function enumerateCycles(
  graph: RoutingGraph,
  maxHops = 5, // Default raised to 5 for increased long-tail discovery potential (see pass_loop strategy comments)
  maxCycles = MAX_CYCLES_PER_PASS,
  getWinRate?: (key: string) => number,
): FoundCycle[] {
  const allCycles = findCycles(graph, maxHops, maxCycles);

  if (getWinRate) {
    // Pre-compute scores to avoid O(N log N) string manipulation in sort
    const scored = allCycles.map((cycle) => {
      const key = routeKeyFromEdges(cycle.edges, cycle.startToken);
      const score = scoreCycleWithFeedback(cycle.logWeight, key, getWinRate);
      return { cycle, score };
    });

    return scored
      .sort((a, b) => a.score - b.score)
      .slice(0, maxCycles)
      .map((s) => s.cycle);
  }

  return allCycles.sort((a, b) => a.logWeight - b.logWeight).slice(0, maxCycles);
}
