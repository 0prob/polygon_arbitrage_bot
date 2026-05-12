type FreshnessLike = {
  ok: boolean;
  reason?: string;
  ageMs?: number;
  skewMs?: number;
};

type CandidateLike<TPath> = {
  path: TPath;
};

export function partitionFreshCandidates<TPath, TCandidate extends CandidateLike<TPath>>(
  candidates: TCandidate[],
  getFreshness: (path: TPath) => FreshnessLike,
) {
  // Early return for empty input
  if (candidates.length === 0) return { fresh: [], stale: [] };

  const fresh: TCandidate[] = [];
  const stale: Array<{ candidate: TCandidate; freshness: FreshnessLike }> = [];

  for (const candidate of candidates) {
    const freshness = getFreshness(candidate.path);
    if (freshness.ok) {
      fresh.push(candidate);
    } else {
      stale.push({ candidate, freshness });
    }
  }

  return { fresh, stale };
}
