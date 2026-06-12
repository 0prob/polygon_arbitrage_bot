import type { ExecutionTracker } from "../execution/tracker.ts";

export interface RankableCandidate {
  routeKey: string;
  expectedProfit: bigint;
  gasLimit?: bigint;
  gasPriceWei: bigint;
}

export function scoreCandidateEv(
  candidate: RankableCandidate,
  winRate: number,
  quarantinePenalty: number = 0,
): number {
  const profit = Number(candidate.expectedProfit);
  const gasCost = Number((candidate.gasLimit ?? 280_000n) * candidate.gasPriceWei);
  const reliability = Math.max(0.05, winRate * (1 - quarantinePenalty));
  return profit * reliability - gasCost;
}

export function sortCandidatesByEv<T extends RankableCandidate>(
  candidates: T[],
  tracker: ExecutionTracker,
  isQuarantined: (routeKey: string) => boolean,
): T[] {
  return [...candidates].sort((a, b) => {
    const scoreA = scoreCandidateEv(a, tracker.getWinRate(a.routeKey), isQuarantined(a.routeKey) ? 0.5 : 0);
    const scoreB = scoreCandidateEv(b, tracker.getWinRate(b.routeKey), isQuarantined(b.routeKey) ? 0.5 : 0);
    return scoreB - scoreA;
  });
}
