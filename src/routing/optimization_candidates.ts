import { routeIdentityFromEdges } from "./route_identity.ts";
import { scoreRoute } from "./score_route.ts";
import { bigintToApproxNumber, toFiniteNumber as normaliseLogWeight, toFiniteNumber } from "../utils/bigint.ts";
import type { RouteLike, RouteResultLike, ScoredRoute } from "./score_route.ts";
import type { RouteIdentityEdge } from "./route_identity.ts";

export type CandidatePathLike = RouteLike & {
  startToken: string;
  edges: Array<RouteIdentityEdge & { protocol: string }>;
  logWeight: unknown;
};

export type CandidateResultLike = Omit<RouteResultLike, "profitable"> & {
  profitable?: boolean;
};

export type CandidateEntryLike = {
  path: CandidatePathLike;
  result: CandidateResultLike;
};

type CandidateScoreInput = CandidateResultLike & { profitable: boolean };

function normalizeCandidateLimit(limit: number) {
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return Math.floor(limit);
}

function compareCandidateProfit(a: CandidateEntryLike, b: CandidateEntryLike) {
  if (b.result.profit > a.result.profit) return 1;
  if (b.result.profit < a.result.profit) return -1;
  return 0;
}

function isViableQuickCandidate(entry: CandidateEntryLike) {
  return entry?.result?.profit != null && entry.result.profit > 0n;
}

function scoreForCandidate(
  entry: CandidateEntryLike,
  options: {
    gasPriceWei: bigint;
    getTokenToMaticRate: (tokenAddress: string) => bigint;
  },
  caches: {
    tokenRates: Map<string, bigint>;
    scored: WeakMap<CandidateEntryLike, ScoredRoute | null>;
  },
) {
  const cachedScore = caches.scored.get(entry);
  if (cachedScore !== undefined) return cachedScore;

  const tokenKey = entry.path.startToken.toLowerCase();
  let tokenToMaticRate = caches.tokenRates.get(tokenKey);
  if (tokenToMaticRate == null) {
    tokenToMaticRate = options.getTokenToMaticRate(entry.path.startToken);
    caches.tokenRates.set(tokenKey, tokenToMaticRate);
  }

  const result: CandidateScoreInput = {
    ...entry.result,
    profitable: entry.result.profitable ?? entry.result.profit > 0n,
  };
  const scored = scoreRoute(entry.path, result, {
    gasPriceWei: options.gasPriceWei,
    tokenToMaticRate: tokenToMaticRate > 0n ? tokenToMaticRate : null,
  });
  caches.scored.set(entry, scored);
  return scored;
}

export function selectOptimizationCandidates<T extends CandidateEntryLike>(
  candidates: T[],
  limit: number,
  options: {
    gasPriceWei: bigint;
    getTokenToMaticRate: (tokenAddress: string) => bigint;
  },
) {
  const normalizedLimit = normalizeCandidateLimit(limit);
  if (normalizedLimit === 0 || candidates.length === 0) return [];
  const viableCandidates = candidates.filter(isViableQuickCandidate);
  if (viableCandidates.length === 0) return [];

  const scoreCaches = {
    tokenRates: new Map<string, bigint>(),
    scored: new WeakMap<CandidateEntryLike, ScoredRoute | null>(),
  };

  // Single pass: score each candidate and find max/min simultaneously
  const scoredCandidates: Array<{
    entry: T;
    profit: bigint;
    roi: number;
    score: number;
    logWeight: number;
    compositeScore: number;
    protocols: Set<string>;
  }> = [];

  let maxProfit = 0n;
  let maxRoi = -Infinity;
  let maxScore = -Infinity;
  let minLogWeight = Infinity;

  for (const entry of viableCandidates) {
    const scored = scoreForCandidate(entry, options, scoreCaches);
    const profit = entry.result?.profit ?? 0n;
    const roi = scored?.roi ?? -Infinity;
    const score = scored?.score ?? -Infinity;
    const logWeight = toFiniteNumber(entry.path.logWeight);
    const protocols = new Set(entry.path.edges.map((e) => e.protocol));

    if (profit > maxProfit) maxProfit = profit;
    if (roi > maxRoi) maxRoi = roi;
    if (score > maxScore) maxScore = score;
    if (logWeight < minLogWeight) minLogWeight = logWeight;

    scoredCandidates.push({ entry, profit, roi, score, logWeight, protocols, compositeScore: 0 });
  }

  // Pre-compute normalization factors
  const profitNormFactor = maxProfit > 0n ? 1000 / bigintToApproxNumber(maxProfit) : 0;

  // Pre-compute composite scores for each candidate (single pass)
  for (const c of scoredCandidates) {
    const profitNorm = profitNormFactor !== 0 ? bigintToApproxNumber(c.profit) * profitNormFactor : 0;
    const roiNorm = maxRoi > 0 ? (c.roi / maxRoi) * 1000 : 0;
    const scoreNorm = maxScore > 0 ? (c.score / maxScore) * 1000 : 0;
    const logWeightNorm = minLogWeight < 0 ? (c.logWeight / minLogWeight) * 500 : 0;
    const diversity = c.protocols.size > 1 ? 200 : 0;
    c.compositeScore = profitNorm * 0.4 + roiNorm * 0.25 + scoreNorm * 0.2 + logWeightNorm * 0.1 + diversity;
  }

  // Sort by pre-computed composite score (no math per comparison)
  scoredCandidates.sort((a, b) => b.compositeScore - a.compositeScore);

  // Select top N with deduplication by route identity
  const selected = new Map<string, T>();
  const fallbackKeys = new WeakMap<T, string>();
  let fallbackKeyId = 0;
  const selectionKeyFor = (entry: T) => {
    try {
      return routeIdentityFromEdges(entry.path.startToken, entry.path.edges);
    } catch {
      let fallbackKey = fallbackKeys.get(entry);
      if (!fallbackKey) {
        fallbackKey = `candidate:${++fallbackKeyId}`;
        fallbackKeys.set(entry, fallbackKey);
      }
      return fallbackKey;
    }
  };

  for (const { entry } of scoredCandidates) {
    const key = selectionKeyFor(entry);
    if (!selected.has(key)) {
      selected.set(key, entry);
      if (selected.size >= normalizedLimit) break;
    }
  }

  return [...selected.values()]
    .sort(compareCandidateProfit)
    .slice(0, normalizedLimit);
}

export function shouldOptimizeCandidate(
  entry: { result?: { profit?: bigint | null } | null } | null | undefined,
  index: number,
  total: number,
  bestQuickProfit: bigint,
) {
  const quickProfit = entry?.result?.profit ?? 0n;
  if (quickProfit <= 0n) return false;

  if (index < 3) return true;
  if (index < Math.ceil(total * 0.4)) return true;
  if (bestQuickProfit <= 0n) return index < Math.ceil(total * 0.5);

  // Preserve optimization for candidates whose quick pass is close to the best.
  return quickProfit * 100n >= bestQuickProfit * 25n;
}
