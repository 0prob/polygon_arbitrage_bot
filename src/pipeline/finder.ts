import type { Address } from "../core/types/common.ts";
import { toBigInt } from "../core/utils/bigint.ts";
import type { RoutingGraph, SwapEdge, FoundCycle } from "./types.ts";
import { MAJOR_TOKENS } from "../core/constants.ts";
import { normalizeProtocol, feeToBps } from "../core/utils/protocol.ts";
import { computeSpotPrice } from "./simulator.ts";
import { estimateSingleTickSpacingCapacity } from "../core/math/uniswap_v3.ts";

function poolHasTickData(state: unknown): boolean {
  const ticks = (state as Record<string, unknown>).ticks;
  return ticks instanceof Map && ticks.size > 0;
}

export function routeKeyFromEdges(edges: SwapEdge[]): string {
  const pools = edges.map((e) => e.poolAddress);
  pools.sort();
  return pools.join(":");
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
  stateCache: { get(key: string): unknown },
  tokenToMaticRates: Map<string, bigint>,
  maxFlashLoanUsd: number = 50_000,
): { low: bigint; high: bigint } {
  const startRate = tokenToMaticRates.get(cycle.startToken.toLowerCase()) ?? 0n;

  let minCapacity = -1n;

  for (const edge of cycle.edges) {
    const addr = edge.poolAddress;
    const state = stateCache.get(addr);
    if (!state) continue;

    // Default fallback: 1000 units (conservative)
    let capacity = 1000n * 10n ** 18n;

    const protocol = normalizeProtocol(edge.protocol);
    if (protocol === "V3" || protocol === "V4" || protocol.includes("ELASTIC")) {
      const rawLiq = (state as Record<string, unknown>).liquidity;
      const liq = toBigInt(rawLiq, 0n);
      const rawSqrt = (state as Record<string, unknown>).sqrtPriceX96;
      const sqrtPriceX96 = toBigInt(rawSqrt, 0n);
      // V3 liquidity L is in virtual sqrt-k units. Convert to real token
      // depth based on swap direction. sqrtPriceX96 encodes ratio of
      // token1/token0 (raw amounts). For zeroForOne (sell token0) we
      // need token0 depth: L * 2^96 / sqrtPriceX96. For !zeroForOne
      // (sell token1) we need token1 depth: L * sqrtPriceX96 / 2^96.
      // If sqrtPriceX96 is 0, we cannot convert L to token units — skip
      // this edge's contribution to avoid using bare L (virtual sqrt-k
      // units) as if it were a real token amount, which would massively
      // overestimate capacity for V3 pools without price data.
      if (sqrtPriceX96 > 0n && liq > 0n) {
        if (edge.zeroForOne) {
          capacity = (liq << 96n) / sqrtPriceX96;
        } else {
          capacity = ((liq * sqrtPriceX96) >> 96n);
        }
        if (!poolHasTickData(state)) {
          const shallowCap = estimateSingleTickSpacingCapacity(state, edge.zeroForOne);
          if (shallowCap > 0n && shallowCap < capacity) {
            capacity = shallowCap;
          }
        }
      } else {
        continue;
      }
    } else if (protocol.includes("BALANCER") || protocol.includes("CURVE")) {
      const balances = (state as any).balances as bigint[] | undefined;
      if (balances && balances.length >= 2) {
        const inIdx = edge.tokenInIdx ?? (edge.zeroForOne ? 0 : 1);
        if (balances[inIdx] > 0n) capacity = balances[inIdx];
      }
    } else if (protocol.includes("DODO")) {
      const baseReserve = toBigInt((state as any).baseReserve, 0n);
      const quoteReserve = toBigInt((state as any).quoteReserve, 0n);
      if (baseReserve > 0n && quoteReserve > 0n) {
        capacity = edge.zeroForOne ? baseReserve : quoteReserve;
      }
    } else if (protocol.includes("WOOFI")) {
      const price = toBigInt((state as any).price, 0n);
      if (price > 0n) {
        // Estimate capacity as total value / price (rough liquidity proxy)
        // WooFi uses a bonded curve with finite reserves per base token.
        const baseState = (state as any).baseStates ?? (state as any).baseTokenStates;
        if (baseState && typeof baseState === "object") {
          const key = typeof edge.tokenIn === "string" ? edge.tokenIn.toLowerCase() : "";
          const bs = key ? (baseState as Record<string, unknown>)[key] : undefined;
          if (bs && typeof bs === "object") {
            const reserve = toBigInt((bs as Record<string, unknown>).reserve, 0n);
            if (reserve > 0n) capacity = reserve;
          }
        }
      }
    } else {
      // V2 pools have reserve0/reserve1 in their state snapshots
      const r0 = toBigInt((state as any).reserve0, 0n);
      const r1 = toBigInt((state as any).reserve1, 0n);
      if (r0 > 0n && r1 > 0n) {
        capacity = edge.zeroForOne ? r0 : r1;
      }
    }

    // Normalize capacity to start token units so minCapacity compares
    // apples-to-apples. Without normalization, a USDC edge (6 decimals)
    // vs a WMATIC edge (18 decimals) would produce wildly different raw
    // numbers for the same economic value, breaking the min comparison.
    if (startRate > 0n) {
      const tokenInAddr = edge.tokenIn;
      const tokenInRate = tokenToMaticRates.get(tokenInAddr.toLowerCase());
      if (tokenInRate && tokenInRate > 0n) {
        capacity = (capacity * tokenInRate) / startRate;
      }
    }

    if (minCapacity === -1n || capacity < minCapacity) {
      minCapacity = capacity;
    }
  }

  // If capacity is zero or NaN (from zero-liquidity V3 pool), fall back.
  if (minCapacity <= 0n) {
    minCapacity = 100n * 10n ** 18n;
  }

  let low = minCapacity / 5000n; // 0.02%
  let high = minCapacity / 10n; // 10%

  // Minimum economic low bound: amounts below this cannot overcome gas costs.
  // Even a 1% net spread on 0.01 MATIC = 1e-4 MATIC profit, far below gas (~0.06).
  // We need the initial search point to be large enough that a reasonable spread
  // (0.1-1%) generates gross profit > gas. For WMATIC ($0.70) that's ~1-10 MATIC.
  // Use 1 MATIC worth (1e18 MATIC wei) as the absolute economic floor.
  const MIN_ECONOMIC_VALUE_MATIC_WEI = 10n ** 18n; // 1 MATIC
  if (startRate > 0n) {
    const minEconomicInToken = (MIN_ECONOMIC_VALUE_MATIC_WEI * 10n ** 18n) / startRate;
    if (low < minEconomicInToken) {
      low = minEconomicInToken;
    }
  }

  // Clamp high to USD cap if we have an oracle rate.
  // Formula: tokenUnits = (USD * 1e18 * 1e18) / startRate
  // (Assuming 1 MATIC = $1 for the purpose of the cap if we don't have a MATIC/USD feed).
  if (startRate > 0n) {
    const maxWei = (BigInt(Math.floor(maxFlashLoanUsd)) * 10n ** 18n * 10n ** 18n) / startRate;
    if (high > maxWei) high = maxWei;
  }

  // Floor the low bound to at least 1% of the high bound (0.1% of capacity),
  // but with an absolute floor of 1 to prevent low=0 for extremely thin pools.
  // This prevents the test amount from being too small to overcome gas + fees for
  // medium-sized pools, while still scaling proportionally so thin pools aren't
  // forced into excessive-slippage territory by a rigid MATIC floor.
  const RELATIVE_LOW_FLOOR = 100n; // 1 / 100 = 1% of high
  const ABSOLUTE_FLOOR = 1n; // prevent low=0 for micro-pools
  const floorLow = high / RELATIVE_LOW_FLOOR;
  const effectiveFloor = floorLow > ABSOLUTE_FLOOR ? floorLow : ABSOLUTE_FLOOR;
  const finalLow = low > effectiveFloor ? low : effectiveFloor;
  const finalHigh = high > finalLow ? high : finalLow + 1n;

  return { low: finalLow, high: finalHigh };
}

const feeLogWeightCache = new Map<bigint, number>();
const FEE_LOG_WEIGHT_CACHE_MAX = 200;
function feeLogWeight(feeBps: bigint): number {
  const cached = feeLogWeightCache.get(feeBps);
  if (cached !== undefined) return cached;
  const feeNum = Math.min(Number(feeBps), 9999);
  const factor = Math.max(1, 10000 - feeNum) / 10000;
  const val = -Math.log(factor);
  if (feeLogWeightCache.size >= FEE_LOG_WEIGHT_CACHE_MAX) {
    const first = feeLogWeightCache.keys().next().value;
    if (first !== undefined) feeLogWeightCache.delete(first);
  }
  feeLogWeightCache.set(feeBps, val);
  return val;
}

export function scoreCycleWithFeedback(logWeight: number, routeKey: string, getWinRate: (key: string) => number): number {
  const winRate = getWinRate(routeKey);
  if (winRate <= 0) return logWeight;
  const feedbackBonus = Math.log(1 + 10 * winRate);
  return logWeight - feedbackBonus;
}

const HOP_PENALTIES_SPOT = [0, 0, 0.0, 0.01, 0.03, 0.08] as const;

/**
 * Re-rank DFS-enumerated cycles by spot-price log weights (same signal as Bellman-Ford).
 * Fee-only DFS scores miss real cross-pool price discrepancies; this puts arb-viable
 * routes at the top of the HF simulation cap.
 */
export function rescoreCyclesBySpotPrice(
  graph: RoutingGraph,
  cycles: FoundCycle[],
  getWinRate?: (key: string) => number,
): { rescored: number; missingSpot: number } {
  let totalMissingSpot = 0;
  for (let i = 0; i < cycles.length; i++) {
    const cycle = cycles[i];
    let logWeight = 0;
    let cumFee = 0n;
    let cycleMissingSpot = 0;
    for (let e = 0; e < cycle.edges.length; e++) {
      const edge = cycle.edges[e];
      const state = graph.stateRefs.get(edge.poolAddress);
      const effBps = feeToBps(edge.protocol, edge.feeBps);
      cumFee += effBps;
      if (!state) {
        logWeight += 15;
        cycleMissingSpot++;
        totalMissingSpot++;
        continue;
      }
      const normalizedProtocol = normalizeProtocol(edge.protocol);
      const spotPrice = computeSpotPrice(normalizedProtocol, edge.zeroForOne, edge.tokenInIdx, edge.tokenOutIdx, state);
      if (spotPrice <= 0) {
        logWeight += 15;
        cycleMissingSpot++;
        totalMissingSpot++;
        continue;
      }
      const feePct = Number(effBps) / 10000;
      logWeight += -Math.log(spotPrice * (1 - feePct));
    }
    const hopPenalty = HOP_PENALTIES_SPOT[cycle.hopCount as 2 | 3 | 4 | 5] ?? cycle.hopCount * 0.15;
    // Penalize hops with missing spot data so complete routes rank above partial ones.
    const missingPenalty = cycleMissingSpot > 0 ? Math.min(5, cycleMissingSpot) * 2 : 0;
    cycle.logWeight = logWeight + hopPenalty + missingPenalty;
    cycle.cumulativeFeeBps = cumFee;
    const key = cycle.id ?? routeKeyFromEdges(cycle.edges);
    let score = getWinRate ? scoreCycleWithFeedback(cycle.logWeight, key, getWinRate) : cycle.logWeight;
    if (MAJOR_TOKENS.has(cycle.startToken)) {
      score -= 2.0;
    }
    cycle.score = score;
  }
  return { rescored: cycles.length, missingSpot: totalMissingSpot };
}

const MAX_CYCLES_PER_PASS = 250_000;

export async function findCycles(
  graph: RoutingGraph,
  maxHops: number,
  maxCycles: number = MAX_CYCLES_PER_PASS,
  logger?: { warn?: (obj: Record<string, unknown>, msg?: string) => void },
): Promise<FoundCycle[]> {
  const cycles: FoundCycle[] = [];
  const hopLimit = Math.min(maxHops, 5);
  const { adjacency } = graph;

  const ENUM_START = Date.now();
  const TIME_BUDGET_MS = 10000;
  let budgetExceededLogged = false;
  let isOverBudget = false;

  let dfsCount = 0;

  // Pre-filter adjacency and pre-calculate weight for all edges.
  // Skip edges with no pool state to avoid enumerating dead cycles.
  const edgeWeight = new Map<string, number>();
  const activeAdjacency = new Map<string, SwapEdge[]>();
  const tokens = Array.from(adjacency.keys());
  for (let tIdx = 0; tIdx < tokens.length; tIdx++) {
    const token = tokens[tIdx];
    const edges = adjacency.get(token)!;
    if (edges.length > 0) {
      const filtered: SwapEdge[] = [];
      for (let eIdx = 0; eIdx < edges.length; eIdx++) {
        const e = edges[eIdx];
        const state = graph.stateRefs.get(e.poolAddress);
        if (!state) continue;
        filtered.push(e);
        if (!edgeWeight.has(e.poolAddress)) {
          // feeBps carries protocol-native units (pips for V3/V4, fee-units for
          // Elastic/WooFi) — normalize to true bps before log-weighting.
          edgeWeight.set(e.poolAddress, feeLogWeight(feeToBps(e.protocol, e.feeBps)));
        }
      }
      if (filtered.length > 0) {
        activeAdjacency.set(token, filtered);
      }
    }
  }

  // Recursive DFS to find cycles of length 2..hopLimit.
  function dfs(
    startToken: string,
    currToken: string,
    path: SwapEdge[],
    usedPools: Set<string>,
    usedTokens: Set<string>,
    hops: number,
    currentLogWeight: number,
    currentCumFee: bigint,
  ): void {
    if (isOverBudget || cycles.length >= maxCycles) return;

    if ((++dfsCount & 1023) === 0) {
      if (Date.now() - ENUM_START > TIME_BUDGET_MS) {
        isOverBudget = true;
        if (!budgetExceededLogged && logger) {
          logger.warn?.(
            {
              elapsedMs: Date.now() - ENUM_START,
              cyclesFound: cycles.length,
              maxCycles,
              budgetMs: TIME_BUDGET_MS,
            },
            "Cycle enumeration over budget or max cycles reached",
          );
          budgetExceededLogged = true;
        }
        return;
      }
    }

    if (hops >= 2 && currToken === startToken) {
      const HOP_PENALTIES = [0, 0, 0.0, 0.01, 0.03, 0.08] as const;
      const hopPenalty = HOP_PENALTIES[hops as 2 | 3 | 4 | 5] ?? hops * 0.15;
      const logWeight = currentLogWeight + hopPenalty;

      cycles.push({
        startToken: startToken as Address,
        edges: path.slice(), // clone to prevent mutations from affecting results
        hopCount: hops,
        logWeight,
        cumulativeFeeBps: currentCumFee,
      });
      return;
    }

    if (usedTokens.has(currToken)) return;

    if (hops >= hopLimit) return;

    const nextEdges = activeAdjacency.get(currToken);
    if (!nextEdges) return;

    usedTokens.add(currToken);

    for (const e of nextEdges) {
      const pAddr = e.poolAddress;
      if (usedPools.has(pAddr)) continue;

      const w = edgeWeight.get(pAddr) ?? 0;
      path.push(e);
      usedPools.add(pAddr);
      dfs(
        startToken,
        e.tokenOut,
        path,
        usedPools,
        usedTokens,
        hops + 1,
        currentLogWeight + w,
        currentCumFee + feeToBps(e.protocol, e.feeBps),
      );
      path.pop();
      usedPools.delete(pAddr);

      if (cycles.length >= maxCycles || isOverBudget) break;
    }

    usedTokens.delete(currToken);
  }

  // Prioritize starting from MAJOR_TOKENS using O(N) partitioning
  const majorTokens: string[] = [];
  const otherTokens: string[] = [];
  for (const token of activeAdjacency.keys()) {
    if (MAJOR_TOKENS.has(token)) {
      majorTokens.push(token);
    } else {
      otherTokens.push(token);
    }
  }
  const prioritizedStartTokens = majorTokens.concat(otherTokens);

  const usedPools = new Set<string>();
  const usedTokens = new Set<string>();
  let lastYield = Date.now();
  for (const startToken of prioritizedStartTokens) {
    if (isOverBudget || Date.now() - ENUM_START > TIME_BUDGET_MS) break;

    const firstEdges = activeAdjacency.get(startToken);
    if (!firstEdges) continue;

    usedTokens.add(startToken);

    for (const e1 of firstEdges) {
      if (cycles.length >= maxCycles || isOverBudget) break;

      // Yield to event loop every 50ms to prevent WS/RPC/TUI starvation.
      // Must live inside the first-edge loop: major start tokens (WMATIC etc.)
      // have hundreds of first edges and each dfs() subtree is sync CPU work —
      // yielding only between start tokens blocked the loop for seconds.
      const now = Date.now();
      if (now - lastYield > 50) {
        await new Promise((r) => setImmediate(r));
        lastYield = Date.now();
      }

      usedPools.add(e1.poolAddress);
      const e1LogWeight = edgeWeight.get(e1.poolAddress) ?? 0;
      dfs(startToken, e1.tokenOut, [e1], usedPools, usedTokens, 1, e1LogWeight, feeToBps(e1.protocol, e1.feeBps));
      usedPools.delete(e1.poolAddress);
    }

    usedTokens.delete(startToken);
  }

  return cycles;
}

export async function enumerateCycles(
  graph: RoutingGraph,
  maxHops = 5, // Default raised to 5 for increased long-tail discovery potential (see pass_loop strategy comments)
  maxCycles = MAX_CYCLES_PER_PASS,
  getWinRate?: (key: string) => number,
  logger?: { warn?: (obj: Record<string, unknown>, msg?: string) => void },
): Promise<FoundCycle[]> {
  const allCycles = await findCycles(graph, maxHops, maxCycles, logger);

  // Use a map to deduplicate by cycle ID (pools only).
  // If multiple entry points (startTokens) exist for the same set of pools,
  // we keep the one with the best (lowest) score.
  const deduped = new Map<string, FoundCycle>();

  for (let i = 0; i < allCycles.length; i++) {
    const cycle = allCycles[i];
    const key = routeKeyFromEdges(cycle.edges);
    cycle.id = key;

    let score = getWinRate ? scoreCycleWithFeedback(cycle.logWeight, key, getWinRate) : cycle.logWeight;

    // Prioritize priceable tokens: bias score for MAJOR_TOKENS
    if (MAJOR_TOKENS.has(cycle.startToken)) {
      score -= 2.0; // Significant bonus for major bases
    }
    cycle.score = score;

    const existing = deduped.get(key);
    if (!existing || score < (existing.score ?? Infinity)) {
      deduped.set(key, cycle);
    }
  }

  const result = Array.from(deduped.values());
  const spotRescore = rescoreCyclesBySpotPrice(graph, result, getWinRate);

  // Hop-stratified retention: a global score cap drops 2–3 hop routes when 5-hop
  // cycles flood the enumerator with artificially low spot scores.
  const byHop = new Map<number, FoundCycle[]>();
  for (const c of result) {
    const list = byHop.get(c.hopCount) ?? [];
    list.push(c);
    byHop.set(c.hopCount, list);
  }
  for (const list of byHop.values()) {
    list.sort((a, b) => a.score! - b.score!);
  }
  const hopQuota: [number, number][] = [
    [2, Math.min(1500, maxCycles)],
    [3, Math.min(2000, maxCycles)],
    [4, Math.min(2000, maxCycles)],
    [5, Math.min(2500, maxCycles)],
  ];
  const stratified: FoundCycle[] = [];
  const hopRetained: Record<number, number> = {};
  for (const [hop, quota] of hopQuota) {
    const tier = byHop.get(hop);
    if (!tier) continue;
    const take = tier.slice(0, quota);
    hopRetained[hop] = take.length;
    stratified.push(...take);
  }
  stratified.sort((a, b) => a.score! - b.score!);
  const limit = Math.min(stratified.length, maxCycles);
  const finalResult = stratified.slice(0, limit);
  return finalResult;
}

export async function findCyclesBellmanFord(
  graph: RoutingGraph,
  maxHops: number = 5,
  maxCycles: number = MAX_CYCLES_PER_PASS,
): Promise<FoundCycle[]> {
  const cycles: FoundCycle[] = [];
  const foundKeys = new Set<string>();

  // Pre-calculate weights for all valid edges in the graph
  type EdgeWithWeight = SwapEdge & { weight: number };
  const weightedAdjacency = new Map<string, EdgeWithWeight[]>();

  for (const [u, edges] of graph.adjacency) {
    const list: EdgeWithWeight[] = [];
    for (const edge of edges) {
      const state = graph.stateRefs.get(edge.poolAddress);
      if (!state) continue;

      const normalizedProtocol = normalizeProtocol(edge.protocol);
      const spotPrice = computeSpotPrice(normalizedProtocol, edge.zeroForOne, edge.tokenInIdx, edge.tokenOutIdx, state);
      if (spotPrice <= 0) continue;

      const feePct = Number(feeToBps(edge.protocol, edge.feeBps)) / 10000;
      const weight = -Math.log(spotPrice * (1 - feePct));
      list.push({ ...edge, weight });
    }
    if (list.length > 0) {
      weightedAdjacency.set(u, list);
    }
  }

  const sourceTokens = Array.from(graph.adjacency.keys()).filter((t) => MAJOR_TOKENS.has(t));
  if (sourceTokens.length === 0) {
    sourceTokens.push(Array.from(graph.adjacency.keys())[0]);
  }

  let lastYield = Date.now();
  for (const sourceToken of sourceTokens) {
    if (cycles.length >= maxCycles) break;

    const now = Date.now();
    if (now - lastYield > 50) {
      await new Promise((r) => setImmediate(r));
      lastYield = Date.now();
    }

    const dist = new Map<string, number>();
    const predNode = new Map<string, string>();
    const predEdge = new Map<string, SwapEdge>();
    dist.set(sourceToken, 0);

    for (let iter = 0; iter < maxHops; iter++) {
      // Each relaxation pass touches every edge — yield so a large graph
      // doesn't block the event loop for the whole maxHops × edges sweep.
      if (Date.now() - lastYield > 50) {
        await new Promise((r) => setImmediate(r));
        lastYield = Date.now();
      }
      let relaxed = false;
      for (const [u, edges] of weightedAdjacency) {
        const uDist = dist.get(u);
        if (uDist === undefined || !Number.isFinite(uDist)) continue;

        for (const edge of edges) {
          const v = edge.tokenOut;
          const oldDist = dist.get(v);
          const newDist = uDist + edge.weight;
          if (oldDist === undefined || newDist < oldDist - 1e-9) {
            dist.set(v, newDist);
            predNode.set(v, u);
            predEdge.set(v, edge);
            relaxed = true;
          }
        }
      }
      if (!relaxed) break;
    }

    for (const [u, edges] of weightedAdjacency) {
      if (cycles.length >= maxCycles) break;
      const uDist = dist.get(u);
      if (uDist === undefined || !Number.isFinite(uDist)) continue;

      for (const edge of edges) {
        const v = edge.tokenOut;
        const vDist = dist.get(v);
        if (vDist === undefined || !Number.isFinite(vDist)) continue;

        if (uDist + edge.weight < vDist - 1e-9) {
          const visited = new Set<string>();
          let curr: string | undefined = u;
          while (curr !== undefined && !visited.has(curr)) {
            visited.add(curr);
            curr = predNode.get(curr);
          }
          const cycleStart = curr;
          if (cycleStart === undefined) continue;

          const cycleEdges: SwapEdge[] = [];
          let trace: string | undefined = cycleStart;
          do {
            const e = predEdge.get(trace);
            if (!e) break;
            cycleEdges.unshift(e);
            trace = predNode.get(trace);
          } while (trace !== undefined && trace !== cycleStart && cycleEdges.length <= maxHops);

          if (!cycleEdges.length) continue;
          const firstEdge = cycleEdges[0];
          const lastEdge = cycleEdges[cycleEdges.length - 1];
          if (!(firstEdge.tokenIn === lastEdge.tokenOut && cycleEdges.length >= 2 && cycleEdges.length <= maxHops)) continue;

          const startToken = firstEdge.tokenIn;
          const key = routeKeyFromEdges(cycleEdges);
          if (!foundKeys.has(key)) {
            foundKeys.add(key);

            let logWeight = 0;
            let cumFee = 0n;
            for (const e of cycleEdges) {
              const effBps = feeToBps(e.protocol, e.feeBps);
              logWeight += feeLogWeight(effBps);
              cumFee += effBps;
            }

            const HOP_PENALTIES_BF = [0, 0, 0.0, 0.01, 0.03, 0.08] as const;
            const hopPenalty = HOP_PENALTIES_BF[cycleEdges.length as 2 | 3 | 4 | 5] ?? cycleEdges.length * 0.15;
            logWeight = logWeight + hopPenalty;

            cycles.push({
              id: key,
              startToken: startToken as Address,
              edges: cycleEdges,
              hopCount: cycleEdges.length,
              logWeight,
              cumulativeFeeBps: cumFee,
            });
          }
        }
      }
    }
  }

  return cycles;
}

export async function enumerateCyclesBellmanFord(
  graph: RoutingGraph,
  maxHops = 5,
  maxCycles = MAX_CYCLES_PER_PASS,
  getWinRate?: (key: string) => number,
): Promise<FoundCycle[]> {
  const allCycles = await findCyclesBellmanFord(graph, maxHops, maxCycles);

  for (let i = 0; i < allCycles.length; i++) {
    const cycle = allCycles[i];
    if (!cycle.id) {
      cycle.id = routeKeyFromEdges(cycle.edges);
    }
    let score = getWinRate ? scoreCycleWithFeedback(cycle.logWeight, cycle.id, getWinRate) : cycle.logWeight;
    if (MAJOR_TOKENS.has(cycle.startToken)) {
      score -= 2.0;
    }
    cycle.score = score;
  }

  allCycles.sort((a, b) => a.score! - b.score!);
  const limit = Math.min(allCycles.length, maxCycles);
  allCycles.length = limit;
  return allCycles;
}
