export interface ExecutionFeedback {
  routeKey: string;
  winRate: number;
  totalAttempts: number;
}

export interface Metrics {
  cycles: number;
  lastCycleDurationMs: number;
  totalErrors: number;
  lastErrorTime: number | null;
  lastErrorMessage: string | null;
  opportunitiesFound: number;
  executionsAttempted: number;
  executionsSuccessful: number;
  executionsFailed: number;
  executionReverts: number;
  trackedRoutes: number;
  startTime: number;
  peakCyclesPerMinute: number;
  currentCyclesPerMinute: number;
}
