import { selectOptimizationCandidates, shouldOptimizeCandidate } from "./optimization_candidates.ts";
import type { CandidateEntryLike } from "./optimization_candidates.ts";
import { mapWithConcurrency } from "../utils/concurrency.ts";

type CandidateAssessmentSummary = {
  shortlisted: number;
  assessed: number;
  missingTokenRates: number;
  optimizedCandidates: number;
  secondChanceOptimized: number;
  profitable: number;
  rejected: number;
  rejectReasons: Record<string, number>;
};

type CandidateAssessmentWorkResult<TAssessment, TCandidate extends CandidateEntryLike> =
  | { kind: "missing_rate" }
  | {
      kind: "assessed";
      candidate: TCandidate;
      result: TCandidate["result"];
      assessment: TAssessment & { shouldExecute: boolean };
      optimizedCandidates: number;
      secondChanceOptimized: number;
    };

function recordAssessmentReject(summary: CandidateAssessmentSummary, reason: string | undefined) {
  summary.rejected++;
  const key = reason && reason.trim() ? reason : "assessment_rejected";
  summary.rejectReasons[key] = (summary.rejectReasons[key] ?? 0) + 1;
}

export async function evaluateCandidatePipeline<TAssessment, TCandidate extends CandidateEntryLike>(
  candidates: TCandidate[],
  options: {
    shortlistLimit: number;
    gasPriceWei: bigint;
    getTokenToMaticRate: (tokenAddress: string) => bigint;
    optimizePath: (
      path: TCandidate["path"],
      quickResult: TCandidate["result"],
      tokenToMaticRate: bigint,
    ) => Promise<TCandidate["result"] | null> | TCandidate["result"] | null;
    assessRoute: (
      path: TCandidate["path"],
      routeResult: TCandidate["result"],
      tokenToMaticRate: bigint,
    ) => TAssessment & { shouldExecute: boolean };
    optimizeConcurrency?: number;
  },
) {
  const tokenRateCache = new Map<string, bigint>();
  const tokenRateFor = (tokenAddress: string) => {
    const key = String(tokenAddress ?? "").toLowerCase();
    const cached = tokenRateCache.get(key);
    if (cached != null) return cached;
    const rate = options.getTokenToMaticRate(tokenAddress);
    tokenRateCache.set(key, rate);
    return rate;
  };
  const shortlisted = selectOptimizationCandidates(candidates, options.shortlistLimit, {
    gasPriceWei: options.gasPriceWei,
    getTokenToMaticRate: tokenRateFor,
  });
  const bestQuickProfit = shortlisted[0]?.result?.profit ?? 0n;
  const profitable: Array<TCandidate & { assessment: TAssessment & { shouldExecute: boolean } }> = [];
  let optimizedCandidates = 0;
  const assessmentSummary: CandidateAssessmentSummary = {
    shortlisted: shortlisted.length,
    assessed: 0,
    missingTokenRates: 0,
    optimizedCandidates: 0,
    secondChanceOptimized: 0,
    profitable: 0,
    rejected: 0,
    rejectReasons: {},
  };

  const workResults = await mapWithConcurrency(
    shortlisted,
    options.optimizeConcurrency ?? 4,
    async (candidate, i): Promise<CandidateAssessmentWorkResult<TAssessment, TCandidate>> => {
      try {
        const { path, result: quickResult } = candidate;
        const tokenToMaticRate = tokenRateFor(path.startToken);
        if (tokenToMaticRate <= 0n) {
          return { kind: "missing_rate" };
        }

        let evaluatedResult = quickResult;
        let optimized = false;
        let candidateOptimizations = 0;
        let secondChanceOptimized = 0;
        if (shouldOptimizeCandidate(candidate, i, shortlisted.length, bestQuickProfit)) {
          candidateOptimizations++;
          optimized = true;
          evaluatedResult = (await options.optimizePath(path, quickResult, tokenToMaticRate)) ?? quickResult;
        }

        let assessment = options.assessRoute(path, evaluatedResult, tokenToMaticRate);
        const assessmentWithReason = assessment as { shouldExecute: boolean; rejectReason?: string };
        const canBenefitFromReoptimization =
          !assessmentWithReason.shouldExecute &&
          !optimized &&
          quickResult.profit > 0n &&
          assessmentWithReason.rejectReason !== "stale_or_missing_token_matic_rate" &&
          !assessmentWithReason.rejectReason?.startsWith("net profit");
        if (canBenefitFromReoptimization) {
          const secondChanceResult = await options.optimizePath(path, quickResult, tokenToMaticRate);
          if (secondChanceResult) {
            candidateOptimizations++;
            secondChanceOptimized++;
            evaluatedResult = secondChanceResult;
            assessment = options.assessRoute(path, evaluatedResult, tokenToMaticRate);
          }
        }

        return {
          kind: "assessed",
          candidate,
          result: evaluatedResult,
          assessment,
          optimizedCandidates: candidateOptimizations,
          secondChanceOptimized,
        };
      } catch (error) {
        console.warn("[candidate_pipeline] Candidate assessment failed:", error);
        return { kind: "missing_rate" };
      }
    },
  );

  for (const workResult of workResults) {
    if (workResult.kind === "missing_rate") {
      assessmentSummary.missingTokenRates++;
      continue;
    }
    assessmentSummary.assessed++;
    optimizedCandidates += workResult.optimizedCandidates;
    assessmentSummary.optimizedCandidates += workResult.optimizedCandidates;
    assessmentSummary.secondChanceOptimized += workResult.secondChanceOptimized;
    if (workResult.assessment.shouldExecute) {
      profitable.push({ ...workResult.candidate, result: workResult.result, assessment: workResult.assessment });
      assessmentSummary.profitable++;
    } else {
      recordAssessmentReject(
        assessmentSummary,
        "rejectReason" in workResult.assessment && typeof workResult.assessment.rejectReason === "string"
          ? workResult.assessment.rejectReason
          : undefined,
      );
    }
  }

  return {
    shortlisted,
    bestQuickProfit,
    optimizedCandidates,
    profitable,
    assessmentSummary,
  };
}
