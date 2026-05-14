import type { BotOpportunityRow, BotState } from "../tui/types.ts";

type CounterMetric = {
  inc: (labels: Record<string, unknown>, value: number) => void;
};

type ObserverMetric = {
  observe: (value: number) => void;
};

export type CandidateMetricsUpdate = {
  candidateCount: number;
  topCandidates: number;
  optimizedCandidates: number;
  profitableRoutes: number;
};

export type PassStateUpdate = {
  passCount: number;
  consecutiveErrors: number;
  stateCacheSize: number;
  cachedPathCount: number;
  lastPassDurationMs: number;
  lastOpportunityCount: number;
  lastPathsEvaluated?: number;
  lastCandidateCount?: number;
  lastShortlistCount?: number;
  lastOptimizedCount?: number;
  lastProfitableCount?: number;
  lastUpdateMs: number;
  opportunities: BotOpportunityRow[];
  // Transaction metrics
  totalTxAttempted?: number;
  totalTxSuccessful?: number;
  totalTxReverted?: number;
  totalProfitWei?: bigint;
  lastProfitWei?: bigint;
  lastTxSuccessRate?: number;
  lastTxSuccessRateMs?: number;
};

export type PassErrorStateUpdate = {
  passCount: number;
  consecutiveErrors: number;
  lastPassDurationMs: number;
  lastUpdateMs: number;
};

type BotTelemetryDeps = {
  state: BotState;
  getPassCount: () => number;
  pathsEvaluated: CounterMetric;
  arbsFound: CounterMetric;
  candidateShortlistSize: ObserverMetric;
  candidateOptimizedCount: ObserverMetric;
  candidateProfitableCount: ObserverMetric;
  candidateProfitableYield: ObserverMetric;
  // Transaction metrics
  txAttempted: CounterMetric;
  txSuccessful: CounterMetric;
  txReverted: CounterMetric;
  profitAccumulator: ObserverMetric;
  now?: () => number;
};

export function createBotTelemetry({
  state,
  getPassCount,
  pathsEvaluated,
  arbsFound,
  candidateShortlistSize,
  candidateOptimizedCount,
  candidateProfitableCount,
  candidateProfitableYield,
  txAttempted,
  txSuccessful,
  txReverted,
  profitAccumulator,
  now = Date.now,
}: BotTelemetryDeps) {
  function recordPathsEvaluated(count: number) {
    state.lastPathsEvaluated = count;
    state.lastUpdateMs = now();
    pathsEvaluated.inc({ pass: getPassCount() }, count);
  }

  function recordCandidateMetrics({ candidateCount, topCandidates, optimizedCandidates, profitableRoutes }: CandidateMetricsUpdate) {
    state.lastCandidateCount = candidateCount;
    state.lastShortlistCount = topCandidates;
    state.lastOptimizedCount = optimizedCandidates;
    state.lastProfitableCount = profitableRoutes;
    state.lastUpdateMs = now();
    candidateShortlistSize.observe(topCandidates);
    candidateOptimizedCount.observe(optimizedCandidates);
    candidateProfitableCount.observe(profitableRoutes);
    candidateProfitableYield.observe(topCandidates > 0 ? profitableRoutes / topCandidates : 0);
  }

  function recordArbsFound(count: number) {
    arbsFound.inc({ pass: getPassCount() }, count);
  }

  // Transaction tracking functions
  function recordTransactionAttempt(success: boolean, profitWei: bigint = 0n) {
    // Update transaction counters
    state.totalTxAttempted++;
    txAttempted.inc({ pass: getPassCount() }, 1);
    if (success) {
      state.totalTxSuccessful++;
      txSuccessful.inc({ pass: getPassCount() }, 1);
      state.totalProfitWei = (state.totalProfitWei ?? 0n) + profitWei;
      state.lastProfitWei = profitWei;
      profitAccumulator.observe(Number(profitWei));
    } else {
      state.totalTxReverted++;
      txReverted.inc({ pass: getPassCount() }, 1);
    }

    // Update success rate
    if (state.totalTxAttempted > 0) {
      state.lastTxSuccessRate = state.totalTxSuccessful / state.totalTxAttempted;
      state.lastTxSuccessRateMs = now();
    }

    state.lastUpdateMs = now();
  }

  function setPassState({
    passCount,
    consecutiveErrors,
    stateCacheSize,
    cachedPathCount,
    lastPassDurationMs,
    lastOpportunityCount,
    lastPathsEvaluated,
    lastCandidateCount,
    lastShortlistCount,
    lastOptimizedCount,
    lastProfitableCount,
    lastUpdateMs,
    opportunities,
    totalTxAttempted: txAtt,
    totalTxSuccessful: txSucc,
    totalTxReverted: txRev,
    totalProfitWei: profitWei,
    lastProfitWei: lastProfit,
  }: PassStateUpdate) {
    state.passCount = passCount;
    state.consecutiveErrors = consecutiveErrors;
    state.stateCacheSize = stateCacheSize;
    state.cachedPathCount = cachedPathCount;
    state.lastPassDurationMs = lastPassDurationMs;
    state.lastOpportunityCount = lastOpportunityCount;
    if (lastPathsEvaluated !== undefined) state.lastPathsEvaluated = lastPathsEvaluated;
    if (lastCandidateCount !== undefined) state.lastCandidateCount = lastCandidateCount;
    if (lastShortlistCount !== undefined) state.lastShortlistCount = lastShortlistCount;
    if (lastOptimizedCount !== undefined) state.lastOptimizedCount = lastOptimizedCount;
    if (lastProfitableCount !== undefined) state.lastProfitableCount = lastProfitableCount;
    state.lastUpdateMs = lastUpdateMs;
    state.opportunities = opportunities;
    if (txAtt !== undefined) state.totalTxAttempted = txAtt;
    if (txSucc !== undefined) state.totalTxSuccessful = txSucc;
    if (txRev !== undefined) state.totalTxReverted = txRev;
    if (profitWei !== undefined) state.totalProfitWei = profitWei;
    if (lastProfit !== undefined) state.lastProfitWei = lastProfit;
    state.lastArbMs = now();
  }

  function setPassErrorState({ passCount, consecutiveErrors, lastPassDurationMs, lastUpdateMs }: PassErrorStateUpdate) {
    state.passCount = passCount;
    state.consecutiveErrors = consecutiveErrors;
    state.lastPassDurationMs = lastPassDurationMs;
    state.lastUpdateMs = lastUpdateMs;
    state.lastArbMs = now();
  }

  return {
    recordPathsEvaluated,
    recordCandidateMetrics,
    recordArbsFound,
    recordTransactionAttempt,
    setPassState,
    setPassErrorState,
  };
}
