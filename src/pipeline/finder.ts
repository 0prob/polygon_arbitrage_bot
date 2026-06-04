import type { Address } from "../core/types/common.ts";
import { toBigInt } from "../core/utils/bigint.ts";
import type { RoutingGraph, SwapEdge, FoundCycle } from "./types.ts";

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

/**
 * Calculate dynamic search bounds (low/high) based on route liquidity capacity.
 *
 * For each edge, we estimate the "safe principal capacity" in start-token units:
 * - V2/Generic: the reserve of the input token.
 * - V3/Elastic: liquidity / 1e12 (heuristic for depth per tick).
 *
 * The route's overall capacity is the minimum capacity along the path.
 * We set the search range to [0.02% .. 10%] of this minimum capacity,
 * clamped by a global MAX_FLASH_LOAN_USD cap.
 */
export function getDynamicSearchBounds(
  cycle: FoundCycle,
  stateCache: Map<string, unknown>,
  tokenToMaticRates: Map<string, bigint>,
  maxFlashLoanUsd: number = 50_000,
): { low: bigint; high: bigint } {
  const startRate = tokenToMaticRates.get(cycle.startToken.toLowerCase()) ?? 0n;

  let minCapacity = -1n;

  for (const edge of cycle.edges) {
    const addr = edge.poolAddress.toLowerCase();
    const state = stateCache.get(addr);
    if (!state) continue;

    // Default fallback: 1000 units (conservative)
    let capacity = 1000n * 10n ** 18n;

    const protocol = (edge.protocol || "").toUpperCase();
    if (protocol.includes("V3") || protocol.includes("V4") || protocol.includes("ELASTIC")) {
      const rawLiq = (state as Record<string, unknown>).liquidity;
      const liq = toBigInt(rawLiq, 0n);
      // V3 heuristic: liquidity / 1e12 is a very rough "depth per tick" equivalent for principal sizing
      capacity = liq / 1_000_000_000_000n;
    } else {
      // V2, Curve, DODO, Balancer etc often have reserve0/reserve1 in their state snapshots
      const r0 = toBigInt((state as any).reserve0, 0n);
      const r1 = toBigInt((state as any).reserve1, 0n);
      if (r0 > 0n && r1 > 0n) {
        capacity = edge.zeroForOne ? r0 : r1;
      }
    }

    if (minCapacity === -1n || capacity < minCapacity) {
      minCapacity = capacity;
    }
  }

  // Final fallback if no capacity could be determined from state: 100 units
  if (minCapacity <= 0n) minCapacity = 100n * 10n ** 18n;

  const low = minCapacity / 5000n; // 0.02%
  let high = minCapacity / 10n; // 10%

  // Clamp high to USD cap if we have an oracle rate.
  // Formula: tokenUnits = (USD * 1e18 * 1e18) / startRate
  // (Assuming 1 MATIC = $1 for the purpose of the cap if we don't have a MATIC/USD feed).
  if (startRate > 0n) {
    const maxWei = (BigInt(Math.floor(maxFlashLoanUsd)) * 10n ** 18n * 10n ** 18n) / startRate;
    if (high > maxWei) high = maxWei;
  }

  // Sanity check: ensure low is at least 1 and high > low
  const finalLow = low > 0n ? low : 1n;
  const finalHigh = high > finalLow ? high : finalLow + 1n;

  return { low: finalLow, high: finalHigh };
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
  if (p.toLowerCase().includes("balancer")) return 1.1;
  if (p.toLowerCase().includes("curve")) return 1.0;
  if (p.toLowerCase().includes("woofi")) return 0.9;

  // Mainstream high-competition (de-prioritize for speed races)
  if (p.includes("uniswap")) return 0.15;
  if (p.includes("quickswap") && !p.includes("_v2")) return 0.25; // V3 quickswap is competitive
  if (p.includes("sushiswap") && !p.includes("_v2")) return 0.3;

  // Other V2s are medium (still better than hot V3 usually)
  if (p.includes("_v2")) return 0.7;

  return 0.5; // default mild bonus for anything non-pure-mainstream
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
  const hopLimit = Math.min(maxHops, 5);
  const { adjacency } = graph;

  const ENUM_START = Date.now();
  const TIME_BUDGET_MS = 3000;

  function overBudget(): boolean {
    return Date.now() - ENUM_START > TIME_BUDGET_MS || cycles.length >= maxCycles;
  }

  // Pre-filter adjacency and pre-calculate obscurity for all edges (same as before for perf)
  type EdgeWithObsc = SwapEdge & { obscurity: number };
  const activeAdjacency = new Map<string, EdgeWithObsc[]>();
  for (const [token, edges] of adjacency) {
    if (edges.length > 0) {
      activeAdjacency.set(
        token,
        edges.map((e) => ({ ...e, obscurity: getObscurityBonus(e.protocol) }) as EdgeWithObsc),
      );
    }
  }

  // Recursive DFS to find cycles of length 2..hopLimit.
  // Matches original unrolled logic exactly:
  // - pool reuse prevention via usedPools (by poolAddress)
  // - early close at depth d prevents extension to d+1 for that prefix (via return after collect)
  // - obs avg + length-specific coefs (0.8,1.1,1.4,1.7) + fee log weights + cum fees
  // - budget + maxCycles respected with early exits
  // - reuses the pre-enriched edge objects in results (same as original)
  function dfs(startToken: string, currToken: string, path: EdgeWithObsc[], usedPools: Set<string>, hops: number): void {
    if (overBudget() || cycles.length >= maxCycles) return;

    if (hops >= 2 && currToken === startToken) {
      // Collect closing cycle at this exact depth (2..hopLimit)
      const obsSum = path.reduce((s, e) => s + e.obscurity, 0);
      const obs = obsSum / hops;
      const coef = 0.8 + (hops - 2) * 0.3; // 0.8 for 2h, 1.1 for 3h, 1.4 for 4h, 1.7 for 5h
      let logWeight = 0;
      let cumFee = 0n;
      for (const e of path) {
        logWeight += feeLogWeight(e.feeBps);
        cumFee += e.feeBps;
      }
      logWeight -= obs * coef;

      cycles.push({
        startToken: startToken as Address,
        edges: [...path] as unknown as SwapEdge[], // clone to prevent mutations from affecting results
        hopCount: hops,
        logWeight,
        cumulativeFeeBps: cumFee,
      });
      return; // do not extend a just-closed cycle (prevents bogus longer cycles from shallower prefixes)
    }

    if (hops >= hopLimit) return;

    const nextEdges = activeAdjacency.get(currToken);
    if (!nextEdges) return;

    for (const e of nextEdges) {
      const pAddr = e.poolAddress.toLowerCase();
      if (usedPools.has(pAddr)) continue;

      path.push(e);
      usedPools.add(pAddr);
      dfs(startToken, e.tokenOut, path, usedPools, hops + 1);
      path.pop();
      usedPools.delete(pAddr);

      if (cycles.length >= maxCycles || overBudget()) break;
    }
  }

  for (const [startToken, firstEdges] of activeAdjacency) {
    if (overBudget()) break;

    for (const e1 of firstEdges) {
      if (cycles.length >= maxCycles) break;
      const used = new Set<string>([e1.poolAddress.toLowerCase()]);
      dfs(startToken, e1.tokenOut, [e1], used, 1);
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
    // Pre-compute scores to avoid O(N log N) string manipulation in sort.
    // NOTE: We deliberately mutate cycle.id here as a performance cache for downstream
    // callers (quarantine, execution, logging). FoundCycle objects are short-lived per
    // enumeration pass and this avoids repeated routeKeyFromEdges work.
    const scored = allCycles.map((cycle) => {
      const key = routeKeyFromEdges(cycle.edges, cycle.startToken);
      cycle.id = key;
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
