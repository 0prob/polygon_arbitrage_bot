import type { Address } from "../core/types/common.ts";
import { toBigInt } from "../core/utils/bigint.ts";
import type { RoutingGraph, SwapEdge, FoundCycle } from "./types.ts";
import { MAJOR_TOKENS } from "../core/constants.ts";
import { normalizeProtocol, computeSpotPrice } from "./simulator.ts";

export function routeKeyFromEdges(edges: SwapEdge[], startToken: Address): string {
  const len = edges.length;
  if (len === 2) {
    const a = edges[0].poolAddress;
    const b = edges[1].poolAddress;
    return a < b ? `${a}:${b}:${startToken}` : `${b}:${a}:${startToken}`;
  }
  if (len === 3) {
    const a = edges[0].poolAddress;
    const b = edges[1].poolAddress;
    const c = edges[2].poolAddress;
    if (a < b) {
      if (b < c) return `${a}:${b}:${c}:${startToken}`;
      if (a < c) return `${a}:${c}:${b}:${startToken}`;
      return `${c}:${a}:${b}:${startToken}`;
    } else {
      if (a < c) return `${b}:${a}:${c}:${startToken}`;
      if (b < c) return `${b}:${c}:${a}:${startToken}`;
      return `${c}:${b}:${a}:${startToken}`;
    }
  }
  // Fallback for longer cycles (4 or 5 hops):
  const parts = new Array<string>(len);
  for (let i = 0; i < len; i++) {
    parts[i] = edges[i].poolAddress;
  }
  parts.sort();
  parts.push(startToken);
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
  const startRate = tokenToMaticRates.get(cycle.startToken) ?? 0n;

  let minCapacity = -1n;

  for (const edge of cycle.edges) {
    const addr = edge.poolAddress;
    const state = stateCache.get(addr);
    if (!state) continue;

    // Default fallback: 1000 units (conservative)
    let capacity = 1000n * 10n ** 18n;

    const protocol = (edge.protocol || "").toUpperCase();
    if (protocol.includes("V3") || protocol.includes("V4") || protocol.includes("ELASTIC")) {
      const rawLiq = (state as Record<string, unknown>).liquidity;
      const liq = toBigInt(rawLiq, 0n);
      const rawSqrt = (state as Record<string, unknown>).sqrtPriceX96;
      const sqrtPriceX96 = toBigInt(rawSqrt, 0n);
      // V3 liquidity L is in virtual sqrt-k units. Convert to real token
      // depth based on swap direction. sqrtPriceX96 encodes ratio of
      // token1/token0 (raw amounts). For zeroForOne (sell token0) we
      // need token0 depth: L * 2^96 / sqrtPriceX96. For !zeroForOne
      // (sell token1) we need token1 depth: L * sqrtPriceX96 / 2^96.
      if (sqrtPriceX96 > 0n && liq > 0n) {
        if (edge.zeroForOne) {
          // token0 = L * 2^96 / sqrtPriceX96
          capacity = (liq << 96n) / sqrtPriceX96 / 1000n;
        } else {
          // token1 = L * sqrtPriceX96 / 2^96
          capacity = ((liq * sqrtPriceX96) >> 96n) / 1000n;
        }
      } else {
        capacity = liq; // bare L as fallback
      }
    } else if (protocol.includes("BALANCER") || protocol.includes("CURVE")) {
      const balances = (state as any).balances as bigint[] | undefined;
      if (balances && balances.length >= 2) {
        const inIdx = edge.tokenInIdx ?? (edge.zeroForOne ? 0 : 1);
        if (balances[inIdx] > 0n) capacity = balances[inIdx];
      }
    } else {
      // V2, DODO, etc often have reserve0/reserve1 in their state snapshots
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
      const tokenInRate = tokenToMaticRates.get(tokenInAddr);
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
function feeLogWeight(feeBps: bigint): number {
  const cached = feeLogWeightCache.get(feeBps);
  if (cached !== undefined) return cached;
  const feeNum = Math.min(Number(feeBps), 9999);
  const factor = Math.max(1, 10000 - feeNum) / 10000;
  const val = -Math.log(factor);
  feeLogWeightCache.set(feeBps, val);
  return val;
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
const obscurityCache = new Map<string, number>();

export function getObscurityBonus(protocol: string): number {
  const cached = obscurityCache.get(protocol);
  if (cached !== undefined) return cached;
  const p = (protocol || "").toLowerCase();

  // Unique AMMs (most likely to have stale/independent prices)
  let result: number;
  if (p.includes("dodo")) result = 1.25;
  else if (p.includes("balancer")) result = 1.1;
  else if (p.includes("curve")) result = 1.0;
  else if (p.includes("woofi")) result = 0.9;
  // V3 liquid – best for 2-hop cycles (0.05% fee tiers → only 0.1% combined)
  else if (p.includes("uniswap") && !p.includes("_v2")) result = 1.0;
  else if (p.includes("quickswap") && !p.includes("_v2")) result = 0.95;
  else if (p.includes("sushiswap") && !p.includes("_v2")) result = 0.9;
  // V2 mainstream (liquid enough for arb)
  else if (p.includes("_v2")) result = 0.35;
  // Long-tail V2 (illiquid, rarely profitable but worth scanning)
  else if (p.includes("dfyn") || p.includes("ape") || p.includes("mesh") || p.includes("jet") || p.includes("cometh")) result = 0.2;
  else result = 0.5; // default mild bonus

  obscurityCache.set(protocol, result);
  return result;
}

export function scoreCycleWithFeedback(logWeight: number, routeKey: string, getWinRate: (key: string) => number): number {
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
  logger?: { warn?: (obj: Record<string, unknown>, msg?: string) => void },
): FoundCycle[] {
  const cycles: FoundCycle[] = [];
  const hopLimit = Math.min(maxHops, 5);
  const { adjacency } = graph;

  const ENUM_START = Date.now();
  const TIME_BUDGET_MS = 10000;
  let budgetExceededLogged = false;

  function overBudget(): boolean {
    const exceeded = Date.now() - ENUM_START > TIME_BUDGET_MS || cycles.length >= maxCycles;
    if (exceeded && !budgetExceededLogged && logger) {
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
    return exceeded;
  }

  // Pre-filter adjacency and pre-calculate obscurity for all edges
  type EdgeWithObsc = SwapEdge & { obscurity: number };
  const activeAdjacency = new Map<string, EdgeWithObsc[]>();
  for (const [token, edges] of adjacency) {
    if (edges.length > 0) {
      const edgesWithObsc = edges.map((e) => ({ ...e, obscurity: getObscurityBonus(e.protocol) }) as EdgeWithObsc);
      // Sort edges by obscurity (desc) to explore higher-alpha paths first
      edgesWithObsc.sort((a, b) => b.obscurity - a.obscurity);
      activeAdjacency.set(token, edgesWithObsc);
    }
  }

  // Recursive DFS to find cycles of length 2..hopLimit.
  // Avoids path reduction loops by incrementally accumulating obscurity, log weight, and fee
  function dfs(
    startToken: string,
    currToken: string,
    path: EdgeWithObsc[],
    usedPools: Set<string>,
    hops: number,
    currentObscuritySum: number,
    currentLogWeight: number,
    currentCumFee: bigint,
  ): void {
    if (overBudget() || cycles.length >= maxCycles) return;

    if (hops >= 2 && currToken === startToken) {
      // Collect closing cycle at this exact depth (2..hopLimit)
      const obs = currentObscuritySum / hops;
      const coef = 0.8 + (hops - 2) * 0.3; // 0.8 for 2h, 1.1 for 3h, 1.4 for 4h, 1.7 for 5h
      const logWeight = currentLogWeight - obs * coef;

      cycles.push({
        startToken: startToken as Address,
        edges: [...path] as unknown as SwapEdge[], // clone to prevent mutations from affecting results
        hopCount: hops,
        logWeight,
        cumulativeFeeBps: currentCumFee,
      });
      return; // do not extend a just-closed cycle (prevents bogus longer cycles from shallower prefixes)
    }

    if (hops >= hopLimit) return;

    const nextEdges = activeAdjacency.get(currToken);
    if (!nextEdges) return;

    for (const e of nextEdges) {
      const pAddr = e.poolAddress;
      if (usedPools.has(pAddr)) continue;

      path.push(e);
      usedPools.add(pAddr);
      dfs(
        startToken,
        e.tokenOut,
        path,
        usedPools,
        hops + 1,
        currentObscuritySum + e.obscurity,
        currentLogWeight + feeLogWeight(e.feeBps),
        currentCumFee + e.feeBps,
      );
      path.pop();
      usedPools.delete(pAddr);

      if (cycles.length >= maxCycles || overBudget()) break;
    }
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

  for (const startToken of prioritizedStartTokens) {
    if (overBudget()) break;
    const firstEdges = activeAdjacency.get(startToken);
    if (!firstEdges) continue;

    for (const e1 of firstEdges) {
      if (cycles.length >= maxCycles) break;
      const used = new Set<string>([e1.poolAddress]);
      const e1LogWeight = feeLogWeight(e1.feeBps);
      dfs(startToken, e1.tokenOut, [e1], used, 1, e1.obscurity, e1LogWeight, e1.feeBps);
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
  logger?: { warn?: (obj: Record<string, unknown>, msg?: string) => void },
): FoundCycle[] {
  const allCycles = findCycles(graph, maxHops, maxCycles, logger);

  if (getWinRate) {
    // Pre-compute scores to avoid O(N log N) string manipulation in sort.
    // NOTE: We deliberately mutate cycle.id here as a performance cache for downstream
    // callers (quarantine, execution, logging). FoundCycle objects are short-lived per
    // enumeration pass and this avoids repeated routeKeyFromEdges work.
    const scored = allCycles.map((cycle) => {
      const key = routeKeyFromEdges(cycle.edges, cycle.startToken);
      cycle.id = key;
      let score = scoreCycleWithFeedback(cycle.logWeight, key, getWinRate);

      // Prioritize priceable tokens: bias score for MAJOR_TOKENS
      if (MAJOR_TOKENS.has(cycle.startToken)) {
        score -= 2.0; // Significant bonus for major bases
      }

      return { cycle, score };
    });

    scored.sort((a, b) => a.score - b.score);
    const limit = Math.min(scored.length, maxCycles);
    const result: FoundCycle[] = new Array(limit);
    for (let i = 0; i < limit; i++) result[i] = scored[i].cycle;
    return result;
  }

  const scored = allCycles.map((cycle) => {
    cycle.id = routeKeyFromEdges(cycle.edges, cycle.startToken);
    let score = cycle.logWeight;
    if (MAJOR_TOKENS.has(cycle.startToken)) {
      score -= 2.0;
    }
    return { cycle, score };
  });

  scored.sort((a, b) => a.score - b.score);
  const limit = Math.min(scored.length, maxCycles);
  const result: FoundCycle[] = new Array(limit);
  for (let i = 0; i < limit; i++) result[i] = scored[i].cycle;
  return result;
}

export function findCyclesBellmanFord(graph: RoutingGraph, maxHops: number = 5, maxCycles: number = MAX_CYCLES_PER_PASS): FoundCycle[] {
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

      const feePct = Number(edge.feeBps) / 10000;
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

  for (const sourceToken of sourceTokens) {
    if (cycles.length >= maxCycles) break;

    const dist = new Map<string, number>();
    const parent = new Map<string, SwapEdge>();
    dist.set(sourceToken, 0);

    // Relax up to maxHops times
    for (let iter = 0; iter < maxHops; iter++) {
      let relaxed = false;
      for (const [u, edges] of weightedAdjacency) {
        const uDist = dist.get(u);
        if (uDist === undefined || uDist === Infinity) continue;

        for (const edge of edges) {
          const v = edge.tokenOut;
          const vDist = dist.get(v) ?? Infinity;
          if (uDist + edge.weight < vDist - 1e-9) {
            dist.set(v, uDist + edge.weight);
            parent.set(v, edge);
            relaxed = true;
          }
        }
      }
      if (!relaxed) break;
    }

    // Check for negative cycles
    for (const [u, edges] of weightedAdjacency) {
      if (cycles.length >= maxCycles) break;
      const uDist = dist.get(u);
      if (uDist === undefined || uDist === Infinity) continue;

      for (const edge of edges) {
        const v = edge.tokenOut;
        const vDist = dist.get(v) ?? Infinity;
        if (uDist + edge.weight < vDist - 1e-9) {
          // Trace back to reconstruct negative cycle
          const visited = new Set<string>();
          let curr = v;
          while (!visited.has(curr)) {
            visited.add(curr);
            const parentEdge = parent.get(curr);
            if (!parentEdge) break;
            curr = parentEdge.tokenIn;
          }

          const cycleEdges: SwapEdge[] = [];
          let trace = curr;
          const traceVisited = new Set<string>();
          while (!traceVisited.has(trace)) {
            traceVisited.add(trace);
            const parentEdge = parent.get(trace);
            if (!parentEdge) break;
            cycleEdges.unshift(parentEdge);
            trace = parentEdge.tokenIn;
          }

          if (cycleEdges.length >= 2 && cycleEdges.length <= maxHops) {
            const firstEdge = cycleEdges[0];
            const lastEdge = cycleEdges[cycleEdges.length - 1];
            if (firstEdge.tokenIn === lastEdge.tokenOut) {
              const startToken = firstEdge.tokenIn;
              const key = routeKeyFromEdges(cycleEdges, startToken);
              if (!foundKeys.has(key)) {
                foundKeys.add(key);

                let logWeight = 0;
                let cumFee = 0n;
                for (const e of cycleEdges) {
                  const fNum = Math.min(Number(e.feeBps), 9999);
                  const factor = Math.max(1, 10000 - fNum) / 10000;
                  logWeight += -Math.log(factor);
                  cumFee += e.feeBps;
                }

                let obsSum = 0;
                for (const e of cycleEdges) {
                  obsSum += getObscurityBonus(e.protocol);
                }
                const obs = obsSum / cycleEdges.length;
                const coef = 0.8 + (cycleEdges.length - 2) * 0.3;
                logWeight -= obs * coef;

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
    }
  }

  return cycles;
}

export function enumerateCyclesBellmanFord(
  graph: RoutingGraph,
  maxHops = 5,
  maxCycles = MAX_CYCLES_PER_PASS,
  getWinRate?: (key: string) => number,
): FoundCycle[] {
  const allCycles = findCyclesBellmanFord(graph, maxHops, maxCycles);

  if (getWinRate) {
    const scored = allCycles.map((cycle) => {
      const key = cycle.id || routeKeyFromEdges(cycle.edges, cycle.startToken);
      cycle.id = key;
      let score = scoreCycleWithFeedback(cycle.logWeight, key, getWinRate);
      if (MAJOR_TOKENS.has(cycle.startToken)) {
        score -= 2.0;
      }
      return { cycle, score };
    });

    scored.sort((a, b) => a.score - b.score);
    const limit = Math.min(scored.length, maxCycles);
    const result: FoundCycle[] = new Array(limit);
    for (let i = 0; i < limit; i++) result[i] = scored[i].cycle;
    return result;
  }

  const scored = allCycles.map((cycle) => {
    cycle.id = cycle.id || routeKeyFromEdges(cycle.edges, cycle.startToken);
    let score = cycle.logWeight;
    if (MAJOR_TOKENS.has(cycle.startToken)) {
      score -= 2.0;
    }
    return { cycle, score };
  });

  scored.sort((a, b) => a.score - b.score);
  const limit = Math.min(scored.length, maxCycles);
  const result: FoundCycle[] = new Array(limit);
  for (let i = 0; i < limit; i++) result[i] = scored[i].cycle;
  return result;
}
