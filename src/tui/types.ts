export interface BotOpportunityRow {
  Route: string;
  Profit: string;
  ROI: string;
}

export interface BotActivityProgress {
  completed?: number;
  total?: number;
  unit?: string;
  label?: string;
}

export interface BotState {
  status: 'idle' | 'running' | 'error';
  mode: string;
  passCount: number;
  consecutiveErrors: number;
  gasPrice: string;
  lastArbMs: number;
  stateCacheSize?: number;
  cachedPathCount?: number;
  lastPassDurationMs?: number;
  lastOpportunityCount?: number;
  lastPathsEvaluated?: number;
  lastCandidateCount?: number;
  lastShortlistCount?: number;
  lastOptimizedCount?: number;
  lastProfitableCount?: number;
  lastUpdateMs?: number;
  currentActivity?: string;
  currentActivityDetail?: string;
  currentActivityUpdatedMs?: number;
  currentActivityProgress?: BotActivityProgress | null;
  opportunities: BotOpportunityRow[];
  logs: string[];
  
  // Transaction metrics
  totalTxAttempted: number;
  totalTxSuccessful: number;
  totalTxReverted: number;
  totalProfitWei?: bigint;
  lastProfitWei?: bigint;
  lastTxSuccessRate?: number;
  lastTxSuccessRateMs?: number;
}
