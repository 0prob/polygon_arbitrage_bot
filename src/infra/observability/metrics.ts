/**
 * Rate-limited structured metrics logging on top of pino.
 * Hot paths stay free of I/O; boundary summaries emit at controlled intervals.
 */

import { isInvalidState } from "../../core/types/pool.ts";

/** Minimal pino-compatible surface used for sampled metrics. */
export type MetricsLogger = {
  debug?: (obj: Record<string, unknown>, msg?: string) => void;
  info?: (obj: Record<string, unknown>, msg?: string) => void;
  warn?: (obj: Record<string, unknown>, msg?: string) => void;
};

const lastEmitMs = new Map<string, number>();

export const METRICS_INTERVAL = {
  lfGraph: 30_000,
  lfCycles: 30_000,
  lfPoolReady: 30_000,
  hfPass: 15_000,
  simBatch: 15_000,
  tokenRates: 15_000,
  poolFetch: 30_000,
} as const;

type LogLevel = "debug" | "info" | "warn";

export function logSampled(
  logger: MetricsLogger | undefined,
  key: string,
  level: LogLevel,
  msg: string,
  data: Record<string, unknown>,
  minIntervalMs: number,
): void {
  if (!logger) return;
  const now = Date.now();
  const last = lastEmitMs.get(key) ?? 0;
  if (now - last < minIntervalMs) return;
  lastEmitMs.set(key, now);
  logger[level](data, msg);
}

// ─── Pure summaries (no side effects) ─────────────────────────────────────────

export function summarizePoolReadiness(
  cycles: { edges: { poolAddress: string }[] }[],
  stateCache: { get(key: string): unknown; has(key: string): boolean },
  cap = 600,
): Record<string, unknown> {
  const slice = cycles.length > cap ? cycles.slice(0, cap) : cycles;
  const pools = new Set<string>();
  for (const c of slice) {
    for (const e of c.edges) pools.add(e.poolAddress.toLowerCase());
  }
  let missing = 0;
  let invalid = 0;
  for (const addr of pools) {
    if (!stateCache.has(addr)) {
      missing++;
      continue;
    }
    const s = stateCache.get(addr);
    if (isInvalidState(s)) invalid++;
  }
  return {
    cyclesChecked: slice.length,
    uniquePools: pools.size,
    missingState: missing,
    invalidState: invalid,
    readyPct: pools.size > 0 ? Math.round(((pools.size - missing - invalid) / pools.size) * 1000) / 10 : 0,
  };
}

export function summarizeRoutingCycles(
  cycles: {
    startToken: string;
    hopCount: number;
    score?: number;
    edges: { tokenIn: string; tokenOut: string; poolAddress: string; feeBps: bigint }[];
  }[],
): Record<string, unknown> {
  let brokenTokenChain = 0;
  let scoreOrderBreaks = 0;
  let duplicatePoolInCycle = 0;
  let feeSuspicious = 0;
  const hopDist: Record<number, number> = {};

  for (let i = 0; i < cycles.length; i++) {
    const c = cycles[i];
    hopDist[c.hopCount] = (hopDist[c.hopCount] ?? 0) + 1;
    if (i > 0 && (c.score ?? Infinity) < (cycles[i - 1]?.score ?? -Infinity)) scoreOrderBreaks++;

    const pools = new Set<string>();
    for (let e = 0; e < c.edges.length; e++) {
      const edge = c.edges[e];
      if (pools.has(edge.poolAddress)) duplicatePoolInCycle++;
      pools.add(edge.poolAddress);
      const next = c.edges[e + 1];
      if (next && edge.tokenOut.toLowerCase() !== next.tokenIn.toLowerCase()) brokenTokenChain++;
      if (edge.feeBps === 0n || edge.feeBps > 100_000n) feeSuspicious++;
    }
    const last = c.edges[c.edges.length - 1];
    if (last && last.tokenOut.toLowerCase() !== c.startToken.toLowerCase()) brokenTokenChain++;
  }

  return {
    cycles: cycles.length,
    brokenTokenChain,
    scoreOrderBreaks,
    duplicatePoolInCycle,
    feeSuspicious,
    hopDist,
    topScore: cycles[0]?.score,
    bottomScore: cycles[cycles.length - 1]?.score,
  };
}

export function summarizeTokenRates(
  pools: { tokens?: string[]; token0?: string; token1?: string }[],
  rates: Map<string, bigint>,
): Record<string, unknown> {
  const uniqueTokens = new Set<string>();
  for (const p of pools) {
    const ts = p.tokens ?? ([p.token0, p.token1].filter(Boolean) as string[]);
    for (const t of ts) uniqueTokens.add(t.toLowerCase());
  }
  let covered = 0;
  for (const t of uniqueTokens) {
    if (rates.has(t) && (rates.get(t) ?? 0n) > 0n) covered++;
  }
  const coveragePct =
    uniqueTokens.size > 0 ? Math.round((covered / uniqueTokens.size) * 100000) / 1000 : 0;
  return { uniqueTokens: uniqueTokens.size, ratesCount: rates.size, covered, coveragePct };
}

export function summarizeCycleRateCoverage(
  cycles: { startToken: string }[],
  rates: Map<string, bigint>,
  simCap?: number,
): Record<string, unknown> {
  const slice = simCap && cycles.length > simCap ? cycles.slice(0, simCap) : cycles;
  let covered = 0;
  for (const c of slice) {
    const r = rates.get(c.startToken.toLowerCase()) ?? 0n;
    if (r > 0n) covered++;
  }
  return {
    total: cycles.length,
    checked: slice.length,
    rateCovered: covered,
    rateCoveredPct: slice.length > 0 ? Math.round((covered / slice.length) * 1000) / 10 : 0,
  };
}

export interface HfPassMetrics {
  elapsedMs: number;
  simMs: number;
  cyclesTotal: number;
  rateSafe: number;
  simCap: number;
  simSkipped: number;
  simHopDist: Record<number, number>;
  ratesCount: number;
  attempted: number;
  simulated: number;
  profitable: number;
  prunedMissing: number;
  prunedNoGross: number;
  prunedFinalCheck: number;
  nearMiss: number;
  maxGrossMilliMatic: number;
  gasPriceGwei: number;
  indexerLag: number;
  rpcOk: boolean;
  hasuraOk: boolean;
  wsOk: boolean;
  tier: string;
  degraded: boolean;
  quarantinedRoutes: number;
  tierAllowsExecute: boolean;
  cycleRates: Record<string, unknown>;
  lfEnumInFlight?: boolean;
  snapGeneration?: number;
}

export function logHfPassMetrics(logger: MetricsLogger | undefined, m: HfPassMetrics): void {
  const ready =
    m.rpcOk &&
    m.hasuraOk &&
    m.cyclesTotal > 0 &&
    m.rateSafe > 0 &&
    m.attempted > 0;

  logSampled(
    logger,
    "hf:pass",
    "debug",
    "HF pass summary",
    {
      ...m,
      arbPipelineReady: ready,
    },
    METRICS_INTERVAL.hfPass,
  );
}
