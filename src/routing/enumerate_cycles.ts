
/**
 * src/routing/enumerate_cycles.js — Arbitrage cycle enumerator
 *
 * Two entry points:
 *
 *  enumerateCycles(graph, opts)
 *    Single-graph (backward-compatible). Hub tokens as start, configurable depth.
 *
 *  enumerateCyclesDual(hubGraph, fullGraph, opts)
 *    Dual-graph hub-first. Phase 1: HUB_4_TOKENS + 4-hop bidirectional BFS.
 *    Phase 2: full POLYGON_HUB_TOKENS + 3-hop only (4-hop too expensive there).
 *
 * Sorting: logWeight ascending (most-negative = highest spot profit).
 * logWeight < 0 is the per-path Bellman-Ford criterion: the cycle is
 * profitable at spot price. Simulation confirms and sizes the optimal trade.
 * Paths with logWeight === 0 (state unknown) are placed last.
 *
 * Liquidity floor ($5k USD):
 *   When minLiquidityWmatic > 0 and getRateWei is provided, pools whose
 *   estimated TVL in WMATIC-wei is known and below threshold are pruned.
 *   $5 000 at $0.70/WMATIC ≈ 7_143n * 10n**18n.
 */

import {
  findArbPaths,
  deduplicatePaths,
  type ArbPath,
  type PathFinderOptions,
  type PathSearchGraph,
  type StartTokenInput,
} from "./finder.ts";
import { POLYGON_HUB_TOKENS, HUB_4_TOKENS } from "./graph.ts";
import { poolLiquidityWmatic } from "./liquidity.ts";
import { toFiniteNumber as normaliseLogWeight } from "../utils/bigint.ts";
import { takeTopNBy } from "../utils/bounded_priority.ts";

// ─── Defaults ────────────────────────────────────────────────

const DEFAULTS = {
  include2Hop:          true,
  include3Hop:          true,
  include4Hop:          false,
  minHops:              2,
  maxHops:              4,
  maxPathsPerToken:     5_000,
  max4HopPathsPerToken: 2_000,
  maxTotalPaths:        20_000,
  hubTokensOnly:        true,
  dedup:                true,
  minV2Reserve:         0n,
  probeWei:             0n,
  minLiquidityWmatic:   0n,
  getRateWei:           null,
};

type RateLookup = (token: string) => bigint;
type CycleGraph = PathSearchGraph & { tokens: Iterable<string> };
export type CycleEnumerationOptions = PathFinderOptions & {
  maxTotalPaths?: number;
  hubTokensOnly?: boolean;
  dedup?: boolean;
  minLiquidityWmatic?: bigint;
  getRateWei?: RateLookup | null;
  startTokens?: StartTokenInput;
  hubStartTokens?: StartTokenInput;
  fullStartTokens?: StartTokenInput;
  hubPathBudget?: number;
};

function normalizeTokenSet(tokens: StartTokenInput) {
  if (typeof tokens === "string") {
    const token = tokens.trim().toLowerCase();
    return token ? new Set([token]) : new Set<string>();
  }
  if (!tokens || typeof tokens[Symbol.iterator] !== "function") return new Set<string>();
  return new Set(
    [...tokens]
      .filter((token): token is string => typeof token === "string")
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token.length > 0),
  );
}

function pruneByLiquidity(paths: ArbPath[], minWmatic: bigint, getRateWei: RateLookup | null) {
  if (minWmatic <= 0n || !getRateWei) return paths;
  const liqCache = new Map<string, bigint>();
  return paths.filter((path) => {
    for (const edge of path.edges) {
      const poolKey = `${edge.poolAddress}:${edge.zeroForOne}`;
      let liq = liqCache.get(poolKey);
      if (liq === undefined) {
        liq = poolLiquidityWmatic(edge, getRateWei);
        liqCache.set(poolKey, liq);
      }
      if (liq > 0n && liq < minWmatic) return false;
    }
    return true;
  });
}

// ─── Sort ─────────────────────────────────────────────────────

function compareByLogWeight(a: ArbPath, b: ArbPath) {
  const noA = a.logWeight === 0 && a.edges.some((edge) => !edge.stateRef);
  const noB = b.logWeight === 0 && b.edges.some((edge) => !edge.stateRef);
  if (noA && !noB) return 1;
  if (!noA && noB) return -1;
  return normaliseLogWeight(a.logWeight) - normaliseLogWeight(b.logWeight);
}

function sortByLogWeight(paths: ArbPath[]) {
  return paths.sort(compareByLogWeight);
}

function normalizePathBudget(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.floor(numeric);
}

function selectTopPaths(paths: ArbPath[], limit: number) {
  const normalizedLimit = normalizePathBudget(limit);
  if (normalizedLimit <= 0) return [];
  if (paths.length <= normalizedLimit) return sortByLogWeight(paths);
  return takeTopNBy(paths, normalizedLimit, compareByLogWeight);
}

function resolvePhaseBudget(rawBudget: number | undefined, maxTotal: number, fallbackRatio: number) {
  const normalizedMax = normalizePathBudget(maxTotal);
  if (normalizedMax <= 0) return 0;
  const fallback = Math.ceil(normalizedMax * fallbackRatio);
  const requested = rawBudget ?? fallback;
  const requestedBudget = normalizePathBudget(requested);
  return Math.max(0, Math.min(normalizedMax, requestedBudget));
}

// ─── Single-graph (backward-compatible) ──────────────────────

export function enumerateCycles(graph: CycleGraph, options: CycleEnumerationOptions = {}): ArbPath[] {
  const opts = { ...DEFAULTS, ...options };
  const maxTotal = normalizePathBudget(opts.maxTotalPaths);
  if (maxTotal <= 0) return [];

  let startTokens: Set<string>;
  if (opts.startTokens) {
    startTokens = normalizeTokenSet(opts.startTokens);
  } else if (opts.hubTokensOnly) {
    startTokens = new Set([...POLYGON_HUB_TOKENS].filter((t) => graph.hasToken(t)));
  } else {
    startTokens = normalizeTokenSet(graph.tokens);
  }

  if (startTokens.size === 0) {
    console.warn("[enumerate_cycles] No valid start tokens in graph");
    return [];
  }

  let paths = findArbPaths(graph, startTokens, {
    include2Hop:          opts.include2Hop,
    include3Hop:          opts.include3Hop,
    include4Hop:          opts.include4Hop,
    minHops:              opts.minHops,
    maxHops:              opts.maxHops,
    maxPathsPerToken:     opts.maxPathsPerToken,
    max4HopPathsPerToken: opts.max4HopPathsPerToken,
    minV2Reserve:         opts.minV2Reserve,
    probeWei:             opts.probeWei,
    minLiquidityWmatic:   opts.minLiquidityWmatic,
    getRateWei:           opts.getRateWei,
  });

  if (opts.dedup) paths = deduplicatePaths(paths);
  if (opts.minLiquidityWmatic > 0n && opts.getRateWei) {
    paths = pruneByLiquidity(paths, opts.minLiquidityWmatic, opts.getRateWei);
  }
  return selectTopPaths(paths, maxTotal);
}

// ─── Dual-graph hub-first (preferred) ────────────────────────

export function enumerateCyclesDual(
  hubGraph: CycleGraph,
  fullGraph: CycleGraph,
  options: CycleEnumerationOptions = {},
): ArbPath[] {
  const opts      = { ...DEFAULTS, ...options };
  const maxTotal  = normalizePathBudget(opts.maxTotalPaths);
  if (maxTotal <= 0) return [];
  const hubBudget = resolvePhaseBudget(opts.hubPathBudget, maxTotal, 0.6);
  const pruneOpts = { minV2Reserve: opts.minV2Reserve, probeWei: opts.probeWei };

  // Phase 1: hub graph — all depths including 4-hop bidirectional
  let hubPaths: ArbPath[] = [];
  if (hubBudget > 0) {
    const rawHubStart = opts.hubStartTokens ?? HUB_4_TOKENS;
    const hubStart = new Set([...normalizeTokenSet(rawHubStart)].filter((t) => hubGraph.hasToken(t)));
    if (hubStart.size === 0) {
      hubPaths = [];
    } else {
      hubPaths = findArbPaths(hubGraph, hubStart, {
        include2Hop: opts.include2Hop,
        include3Hop: opts.include3Hop,
        include4Hop: opts.include4Hop,
        minHops: opts.minHops,
        maxHops: opts.maxHops,
        maxPathsPerToken: opts.maxPathsPerToken,
        max4HopPathsPerToken: opts.max4HopPathsPerToken,
        ...pruneOpts,
        minLiquidityWmatic: opts.minLiquidityWmatic,
        getRateWei: opts.getRateWei,
      });
      if (opts.dedup) hubPaths = deduplicatePaths(hubPaths);
      hubPaths = selectTopPaths(hubPaths, hubBudget);
    }
  }

  // Phase 2: full graph — 3-hop only (4-hop too expensive on large graph)
  const fullBudget = Math.max(0, maxTotal - hubPaths.length);
  let fullPaths: ArbPath[] = [];
  if (fullBudget > 0) {
    const rawFullStart = opts.fullStartTokens ?? POLYGON_HUB_TOKENS;
    const fullStart = new Set([...normalizeTokenSet(rawFullStart)].filter((t) => fullGraph.hasToken(t)));
    if (fullStart.size > 0) {
      fullPaths = findArbPaths(fullGraph, fullStart, {
        include2Hop: opts.include2Hop, include3Hop: opts.include3Hop, include4Hop: false,
        minHops: opts.minHops,
        maxHops: Math.min(opts.maxHops, 3),
        maxPathsPerToken: opts.maxPathsPerToken,
        ...pruneOpts,
        minLiquidityWmatic: opts.minLiquidityWmatic,
        getRateWei: opts.getRateWei,
      });
      if (opts.dedup) fullPaths = deduplicatePaths(fullPaths);
      fullPaths = selectTopPaths(fullPaths, fullBudget);
    }
  }

  // Merge, cross-phase dedup, liquidity prune, final sort + cap
  let all = [...hubPaths, ...fullPaths];
  if (opts.dedup) all = deduplicatePaths(all);
  if (opts.minLiquidityWmatic > 0n && opts.getRateWei) {
    all = pruneByLiquidity(all, opts.minLiquidityWmatic, opts.getRateWei);
  }
  return selectTopPaths(all, maxTotal);
}

// ─── Convenience wrappers ────────────────────────────────────

export function enumerateCyclesForToken(
  graph: CycleGraph,
  startToken: string,
  options: CycleEnumerationOptions = {},
): ArbPath[] {
  return enumerateCycles(graph, { ...options, hubTokensOnly: false, startTokens: new Set([startToken]) });
}

export function cycleSummary(cycles: ArbPath[]) {
  const byHops: Record<string, number> = {};
  const byProtocol: Record<string, number> = {};
  let crossProtocol = 0;
  for (const c of cycles) {
    byHops[c.hopCount] = (byHops[c.hopCount] || 0) + 1;
    const protos = new Set(c.edges.map((edge) => edge.protocol));
    for (const p of protos) byProtocol[p] = (byProtocol[p] || 0) + 1;
    if (protos.size > 1) crossProtocol++;
  }
  return { total: cycles.length, byHops, byProtocol, crossProtocol };
}
