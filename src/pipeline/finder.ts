import type { Address } from "../core/types/common.ts";
import { toBigInt } from "../core/utils/bigint.ts";
import { isInvalidState } from "../core/types/pool.ts";
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

/** Hop bucket for HF sim selection: 0=≤2, 1=3, 2=4, 3=5+ */
export function hopSimBucket(hopCount: number): number {
  if (hopCount <= 2) return 0;
  if (hopCount === 3) return 1;
  if (hopCount === 4) return 2;
  return 3;
}

const LONG_TAIL_PROTOCOLS = new Set([
  "DFYN_V2",
  "APESWAP_V2",
  "MESHSWAP_V2",
  "JETSWAP_V2",
  "COMETHSWAP_V2",
  "DODO_V2",
  "BALANCER_V2",
  "CURVE",
  "WOOFI",
]);

/** Score bonus for long-tail / multi-hop routes (lower score = ranked higher). */
export function longTailRouteBonus(cycle: FoundCycle): number {
  let obscureHops = 0;
  for (const e of cycle.edges) {
    if (LONG_TAIL_PROTOCOLS.has(e.protocol.toUpperCase())) obscureHops++;
  }
  let bonus = obscureHops * -0.05;
  if (cycle.hopCount >= 3) {
    bonus -= 0.02 * (cycle.hopCount - 2);
  }
  return bonus;
}

/** Per-hop minimum slots before global score fill (scaled down when maxCycles is smaller). */
export const DEFAULT_HOP_QUOTAS: ReadonlyMap<number, number> = new Map([
  [2, 1500],
  [3, 2000],
  [4, 2000],
  [5, 2500],
]);

/**
 * Guarantee hop representation in the capped cycle list: fill per-hop quotas first,
 * then top up globally by score. Prevents 5-hop floods from evicting 2–3 hop routes.
 */
export function applyHopStratifiedCap(
  cycles: FoundCycle[],
  maxCycles: number,
  quotas: ReadonlyMap<number, number> = DEFAULT_HOP_QUOTAS,
): FoundCycle[] {
  if (cycles.length <= maxCycles) {
    cycles.sort((a, b) => (a.score ?? Infinity) - (b.score ?? Infinity));
    return cycles;
  }

  const byHop = new Map<number, FoundCycle[]>();
  for (const c of cycles) {
    const list = byHop.get(c.hopCount) ?? [];
    list.push(c);
    byHop.set(c.hopCount, list);
  }
  for (const list of byHop.values()) {
    list.sort((a, b) => (a.score ?? Infinity) - (b.score ?? Infinity));
  }

  const totalQuota = [...quotas.values()].reduce((s, q) => s + q, 0);
  const scale = totalQuota > maxCycles ? maxCycles / totalQuota : 1;

  const selected: FoundCycle[] = [];
  const selectedIds = new Set<string>();
  const hopKeys = [...quotas.keys()].sort((a, b) => a - b);

  for (const hop of hopKeys) {
    const tier = byHop.get(hop);
    if (!tier) continue;
    const quota = Math.max(0, Math.floor((quotas.get(hop) ?? 0) * scale));
    for (let i = 0; i < tier.length && i < quota && selected.length < maxCycles; i++) {
      const c = tier[i];
      const key = c.id ?? routeKeyFromEdges(c.edges);
      if (selectedIds.has(key)) continue;
      selectedIds.add(key);
      selected.push(c);
    }
  }

  if (selected.length < maxCycles) {
    const rest = cycles
      .filter((c) => !selectedIds.has(c.id ?? routeKeyFromEdges(c.edges)))
      .sort((a, b) => (a.score ?? Infinity) - (b.score ?? Infinity));
    for (const c of rest) {
      if (selected.length >= maxCycles) break;
      const key = c.id ?? routeKeyFromEdges(c.edges);
      if (selectedIds.has(key)) continue;
      selectedIds.add(key);
      selected.push(c);
    }
  }

  selected.sort((a, b) => (a.score ?? Infinity) - (b.score ?? Infinity));
  return selected;
}

/**
 * Build a rotation window with proportional hop representation (for HF sim batch).
 */
export function buildHopBalancedWindow(cycles: FoundCycle[], windowSize: number, offset: number): FoundCycle[] {
  if (cycles.length <= windowSize) return cycles;

  const byBucket: FoundCycle[][] = [[], [], [], []];
  for (const c of cycles) {
    byBucket[hopSimBucket(c.hopCount)].push(c);
  }

  const window: FoundCycle[] = [];
  const activeBuckets = byBucket.filter((b) => b.length > 0);
  const perBucket = Math.max(1, Math.ceil(windowSize / activeBuckets.length));

  for (let b = 0; b < byBucket.length; b++) {
    const tier = byBucket[b];
    if (tier.length === 0) continue;
    const start = tier.length > 0 ? (offset + b * 97) % tier.length : 0;
    for (let i = 0; i < perBucket && window.length < windowSize; i++) {
      window.push(tier[(start + i) % tier.length]);
    }
  }

  return window.length > 0 ? window : cycles.slice(0, windowSize);
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

/** Dedupe raw cycles by pool set, apply win-rate / major-token / long-tail scoring. */
export function dedupeScoredCycles(
  allCycles: FoundCycle[],
  getWinRate?: (key: string) => number,
): FoundCycle[] {
  const deduped = new Map<string, FoundCycle>();

  for (let i = 0; i < allCycles.length; i++) {
    const cycle = allCycles[i];
    const key = routeKeyFromEdges(cycle.edges);
    cycle.id = key;

    let score = getWinRate ? scoreCycleWithFeedback(cycle.logWeight, key, getWinRate) : cycle.logWeight;

    if (MAJOR_TOKENS.has(cycle.startToken)) {
      score -= 2.0;
    }
    score += longTailRouteBonus(cycle);
    cycle.score = score;

    const existing = deduped.get(key);
    if (!existing || score < (existing.score ?? Infinity)) {
      deduped.set(key, cycle);
    }
  }

  return Array.from(deduped.values());
}

/**
 * Post-process raw cycle enumeration: dedupe, spot-price rescore, hop-stratified cap.
 * Call once after merging multi-pass findCycles batches (LF path).
 */
export function finalizeEnumeratedCycles(
  graph: RoutingGraph,
  rawCycles: FoundCycle[],
  maxCycles: number,
  getWinRate?: (key: string) => number,
): FoundCycle[] {
  const deduped = dedupeScoredCycles(rawCycles, getWinRate);
  rescoreCyclesBySpotPrice(graph, deduped, getWinRate);
  return applyHopStratifiedCap(deduped, maxCycles);
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
    score += longTailRouteBonus(cycle);
    cycle.score = score;
  }
  return { rescored: cycles.length, missingSpot: totalMissingSpot };
}

const MAX_CYCLES_PER_PASS = 250_000;
const CYCLE_ENUM_TIME_BUDGET_MS = 10_000;

export interface CycleSearchPass {
  maxHops: number;
  maxCycles: number;
}

interface CycleSearchPrep {
  activeAdjacency: Map<string, SwapEdge[]>;
  edgeWeight: Map<string, number>;
  prioritizedStartTokens: string[];
}

interface CycleSearchBudget {
  startMs: number;
  exceeded: boolean;
  logged: boolean;
}

function prepareCycleSearchGraph(graph: RoutingGraph): CycleSearchPrep {
  const edgeWeight = new Map<string, number>();
  const activeAdjacency = new Map<string, SwapEdge[]>();
  const { adjacency } = graph;

  for (const [token, edges] of adjacency) {
    if (edges.length === 0) continue;
    const filtered: SwapEdge[] = [];
    for (const e of edges) {
      const state = graph.stateRefs.get(e.poolAddress);
      if (!state || isInvalidState(state)) continue;
      filtered.push(e);
      if (!edgeWeight.has(e.poolAddress)) {
        edgeWeight.set(e.poolAddress, feeLogWeight(feeToBps(e.protocol, e.feeBps)));
      }
    }
    if (filtered.length > 0) {
      activeAdjacency.set(token, filtered);
    }
  }

  const majorTokens: string[] = [];
  const otherTokens: string[] = [];
  for (const token of activeAdjacency.keys()) {
    if (MAJOR_TOKENS.has(token)) majorTokens.push(token);
    else otherTokens.push(token);
  }

  return {
    activeAdjacency,
    edgeWeight,
    prioritizedStartTokens: majorTokens.concat(otherTokens),
  };
}

async function collectCyclesPrepared(
  prep: CycleSearchPrep,
  hopLimit: number,
  maxCycles: number,
  budget: CycleSearchBudget,
  logger?: { warn?: (obj: Record<string, unknown>, msg?: string) => void },
): Promise<FoundCycle[]> {
  const cycles: FoundCycle[] = [];
  const hopCap = Math.min(hopLimit, 8);
  let dfsCount = 0;

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
    if (budget.exceeded || cycles.length >= maxCycles) return;

    if ((++dfsCount & 1023) === 0) {
      if (Date.now() - budget.startMs > CYCLE_ENUM_TIME_BUDGET_MS) {
        budget.exceeded = true;
        if (!budget.logged && logger) {
          logger.warn?.(
            {
              elapsedMs: Date.now() - budget.startMs,
              cyclesFound: cycles.length,
              maxCycles,
              budgetMs: CYCLE_ENUM_TIME_BUDGET_MS,
            },
            "Cycle enumeration over budget or max cycles reached",
          );
          budget.logged = true;
        }
        return;
      }
    }

    if (hops >= 2 && currToken === startToken) {
      const HOP_PENALTIES = [0, 0, 0.0, 0.01, 0.03, 0.08] as const;
      const hopPenalty = HOP_PENALTIES[hops as 2 | 3 | 4 | 5] ?? hops * 0.15;
      cycles.push({
        startToken: startToken as Address,
        edges: path.slice(),
        hopCount: hops,
        logWeight: currentLogWeight + hopPenalty,
        cumulativeFeeBps: currentCumFee,
      });
      return;
    }

    if (usedTokens.has(currToken) || hops >= hopCap) return;

    const nextEdges = prep.activeAdjacency.get(currToken);
    if (!nextEdges) return;

    usedTokens.add(currToken);

    for (const e of nextEdges) {
      const pAddr = e.poolAddress;
      if (usedPools.has(pAddr)) continue;

      const w = prep.edgeWeight.get(pAddr) ?? 0;
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

      if (cycles.length >= maxCycles || budget.exceeded) break;
    }

    usedTokens.delete(currToken);
  }

  const usedPools = new Set<string>();
  const usedTokens = new Set<string>();
  let lastYield = Date.now();
  for (const startToken of prep.prioritizedStartTokens) {
    if (budget.exceeded || Date.now() - budget.startMs > CYCLE_ENUM_TIME_BUDGET_MS) break;

    const firstEdges = prep.activeAdjacency.get(startToken);
    if (!firstEdges) continue;

    usedTokens.add(startToken);

    for (const e1 of firstEdges) {
      if (cycles.length >= maxCycles || budget.exceeded) break;

      const now = Date.now();
      if (now - lastYield > 50) {
        await new Promise((r) => setImmediate(r));
        lastYield = Date.now();
      }

      usedPools.add(e1.poolAddress);
      const e1LogWeight = prep.edgeWeight.get(e1.poolAddress) ?? 0;
      dfs(startToken, e1.tokenOut, [e1], usedPools, usedTokens, 1, e1LogWeight, feeToBps(e1.protocol, e1.feeBps));
      usedPools.delete(e1.poolAddress);
    }

    usedTokens.delete(startToken);
  }

  return cycles;
}

/** Run multiple hop-limited DFS passes sharing one adjacency prep and one time budget. */
export async function findCyclesMultiPass(
  graph: RoutingGraph,
  passes: CycleSearchPass[],
  logger?: { warn?: (obj: Record<string, unknown>, msg?: string) => void },
): Promise<FoundCycle[]> {
  if (passes.length === 0) return [];
  const prep = prepareCycleSearchGraph(graph);
  const budget: CycleSearchBudget = { startMs: Date.now(), exceeded: false, logged: false };
  const all: FoundCycle[] = [];
  for (const pass of passes) {
    if (budget.exceeded) break;
    const batch = await collectCyclesPrepared(prep, pass.maxHops, pass.maxCycles, budget, logger);
    all.push(...batch);
  }
  return all;
}

export async function findCycles(
  graph: RoutingGraph,
  maxHops: number,
  maxCycles: number = MAX_CYCLES_PER_PASS,
  logger?: { warn?: (obj: Record<string, unknown>, msg?: string) => void },
): Promise<FoundCycle[]> {
  const prep = prepareCycleSearchGraph(graph);
  const budget: CycleSearchBudget = { startMs: Date.now(), exceeded: false, logged: false };
  return collectCyclesPrepared(prep, maxHops, maxCycles, budget, logger);
}

export async function enumerateCycles(
  graph: RoutingGraph,
  maxHops = 5, // Default raised to 5 for increased long-tail discovery potential (see pass_loop strategy comments)
  maxCycles = MAX_CYCLES_PER_PASS,
  getWinRate?: (key: string) => number,
  logger?: { warn?: (obj: Record<string, unknown>, msg?: string) => void },
): Promise<FoundCycle[]> {
  const allCycles = await findCycles(graph, maxHops, maxCycles, logger);
  return finalizeEnumeratedCycles(graph, allCycles, maxCycles, getWinRate);
}

type EdgeWithWeight = SwapEdge & { weight: number };

function buildBellmanFordAdjacency(graph: RoutingGraph): Map<string, EdgeWithWeight[]> {
  const weightedAdjacency = new Map<string, EdgeWithWeight[]>();

  for (const [u, edges] of graph.adjacency) {
    const list: EdgeWithWeight[] = [];
    for (const edge of edges) {
      const state = graph.stateRefs.get(edge.poolAddress);
      if (!state || isInvalidState(state)) continue;

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

  return weightedAdjacency;
}

async function collectBellmanFordCycles(
  weightedAdjacency: Map<string, EdgeWithWeight[]>,
  maxHops: number,
  maxCycles: number,
): Promise<FoundCycle[]> {
  const cycles: FoundCycle[] = [];
  const foundKeys = new Set<string>();

  const sourceTokens = Array.from(weightedAdjacency.keys()).filter((t) => MAJOR_TOKENS.has(t));
  if (sourceTokens.length === 0) {
    sourceTokens.push(Array.from(weightedAdjacency.keys())[0]);
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

/** Multiple Bellman-Ford passes sharing one weighted adjacency build. */
export async function findCyclesBellmanFordMultiPass(
  graph: RoutingGraph,
  passes: CycleSearchPass[],
): Promise<FoundCycle[]> {
  if (passes.length === 0) return [];
  const weightedAdjacency = buildBellmanFordAdjacency(graph);
  const all: FoundCycle[] = [];
  for (const pass of passes) {
    const batch = await collectBellmanFordCycles(weightedAdjacency, pass.maxHops, pass.maxCycles);
    all.push(...batch);
  }
  return all;
}

export async function findCyclesBellmanFord(
  graph: RoutingGraph,
  maxHops: number = 5,
  maxCycles: number = MAX_CYCLES_PER_PASS,
): Promise<FoundCycle[]> {
  const weightedAdjacency = buildBellmanFordAdjacency(graph);
  return collectBellmanFordCycles(weightedAdjacency, maxHops, maxCycles);
}

export async function enumerateCyclesBellmanFord(
  graph: RoutingGraph,
  maxHops = 5,
  maxCycles = MAX_CYCLES_PER_PASS,
  getWinRate?: (key: string) => number,
): Promise<FoundCycle[]> {
  const allCycles = await findCyclesBellmanFord(graph, maxHops, maxCycles);
  return finalizeEnumeratedCycles(graph, allCycles, maxCycles, getWinRate);
}
