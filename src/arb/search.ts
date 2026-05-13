import {
  assessRouteResult,
  compareAssessmentProfit,
  getAssessmentOptimizationOptions,
  type AssessmentLike,
  type AssessmentOptimizationOptions,
  type ArbPathLike,
  type CandidateEntry,
  type ExecutableCandidate,
  type RouteResultLike,
} from "./assessment.ts";
import { getResultHopCount } from "../routing/path_hops.ts";
import type { RouteStateCache } from "../routing/simulation_types.ts";
import type { PoolRecord } from "../state/warmup.ts";

type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";
type LoggerFn = (msg: string, level?: LogLevel, meta?: unknown) => void;
type FeeSnapshot = {
  maxFee?: bigint;
  effectiveGasPriceWei?: bigint;
  updatedAt?: number;
} | null;
export type RawRouteResult = {
  amountIn?: unknown;
  amountOut?: unknown;
  profit?: unknown;
  profitable?: unknown;
  totalGas?: unknown;
  poolPath?: unknown;
  tokenPath?: unknown;
  hopAmounts?: unknown;
  hopCount?: unknown;
};
type CandidatePipelineResult = {
  shortlisted: CandidateEntry[];
  optimizedCandidates: number;
  profitable: ExecutableCandidate[];
  assessmentSummary?: {
    shortlisted: number;
    assessed: number;
    missingTokenRates: number;
    optimizedCandidates: number;
    secondChanceOptimized: number;
    profitable: number;
    rejected: number;
    rejectReasons: Record<string, number>;
  };
};
type ScanPathSelection = {
  paths: ArbPathLike[];
  duplicatePaths: number;
  stalePaths: number;
  staleReasons: string[];
};

const STALE_SCAN_ROUTE_REFRESH_PATH_LIMIT = 64;
const STALE_SCAN_ROUTE_REFRESH_POOL_LIMIT = 32;

function normalizeToBigInt(value: unknown, fallback: bigint = 0n): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "boolean") return value ? 1n : 0n;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value)) return fallback;
    try {
      return BigInt(value);
    } catch {
      return fallback;
    }
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return fallback;
    if (!/^-?\d+$/.test(trimmed)) return fallback;
    try {
      return BigInt(trimmed);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function isMissingRouteAmount(value: unknown) {
  return value == null || (typeof value === "string" && value.trim().length === 0);
}

function normalizeRouteGas(value: unknown) {
  const numeric = Number(value ?? 0);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : -1;
}

function normalizeExplicitHopCount(value: unknown) {
  if (value == null) return undefined;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0;
}

function normalizeProbeAmounts(values: bigint[]) {
  return [...new Set(values.filter((amount) => typeof amount === "bigint" && amount > 0n).map(String))]
    .map((amount) => BigInt(amount));
}

function normalizeRouteAmount(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "boolean") return value ? 1n : 0n;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value)) return 0n;
    try {
      return BigInt(value);
    } catch {
      return 0n;
    }
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return 0n;
    if (!/^-?\d+$/.test(trimmed)) return 0n;
    try {
      return BigInt(trimmed);
    } catch {
      return 0n;
    }
  }
  return 0n;
}

function selectFreshUniqueScanPaths(
  paths: ArbPathLike[],
  deps: Pick<SearchDeps, "routeKeyFromEdges" | "getRouteFreshness">,
): ScanPathSelection {
  const uniqueByRoute = new Map<string, ArbPathLike>();
  let duplicatePaths = 0;

  for (const path of paths) {
    const key = deps.routeKeyFromEdges(path.startToken, path.edges);
    if (uniqueByRoute.has(key)) {
      duplicatePaths++;
      continue;
    }
    uniqueByRoute.set(key, path);
  }

  const staleReasons = new Map<string, number>();
  const freshPaths: ArbPathLike[] = [];
  let stalePaths = 0;
  for (const path of uniqueByRoute.values()) {
    const freshness = deps.getRouteFreshness(path);
    if (freshness.ok) {
      freshPaths.push(path);
      continue;
    }
    stalePaths++;
    const reason = freshness.reason ?? "unknown";
    staleReasons.set(reason, (staleReasons.get(reason) ?? 0) + 1);
  }

  return {
    paths: freshPaths,
    duplicatePaths,
    stalePaths,
    staleReasons: [...staleReasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => `${reason}:${count}`)
      .slice(0, 5),
  };
}

function collectRoutePoolRecordsForRefresh(
  paths: ArbPathLike[],
  deps: Pick<SearchDeps, "getPoolRecord">,
  options: { maxPaths: number; maxPools: number },
) {
  const records: PoolRecord[] = [];
  const seen = new Set<string>();
  let consideredPaths = 0;
  let missingPoolRecords = 0;

  if (!deps.getPoolRecord) return { records, consideredPaths, missingPoolRecords };

  for (const path of paths) {
    if (consideredPaths >= options.maxPaths || records.length >= options.maxPools) break;
    consideredPaths++;
    for (const edge of path.edges ?? []) {
      if (records.length >= options.maxPools) break;
      const address = String(edge.poolAddress ?? "");
      const key = address.toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const record = deps.getPoolRecord(address);
      if (!record) {
        missingPoolRecords++;
        continue;
      }
      records.push(record);
    }
  }

  return { records, consideredPaths, missingPoolRecords };
}

async function refreshStaleScanRoutes(
  cycles: ArbPathLike[],
  deps: Pick<SearchDeps, "getPoolRecord" | "fetchAndCacheStates" | "log">,
) {
  if (!deps.getPoolRecord || !deps.fetchAndCacheStates) return false;
  const { records, consideredPaths, missingPoolRecords } = collectRoutePoolRecordsForRefresh(cycles, deps, {
    maxPaths: STALE_SCAN_ROUTE_REFRESH_PATH_LIMIT,
    maxPools: STALE_SCAN_ROUTE_REFRESH_POOL_LIMIT,
  });
  if (records.length === 0) return false;

  deps.log("[runner] Refreshing stale cached route pool states before scan", "info", {
    event: "scan_stale_route_refresh_start",
    activity: "Refreshing stale route states",
    activityDetail: `${records.length} pool(s) from ${consideredPaths} stale cached route(s)`,
    progressLabel: "scan",
    progressCompleted: 2,
    progressTotal: 3,
    progressUnit: "steps",
    pools: records.length,
    consideredPaths,
    missingPoolRecords,
  });

  await deps.fetchAndCacheStates(records, {
    blockTag: "pending",
    logContext: {
      label: "Stale scan route refresh",
      eventPrefix: "scan_stale_route_refresh",
    },
  });
  return true;
}

export function toRouteResultLike(result: RawRouteResult): RouteResultLike {
  const amountIn = normalizeRouteAmount(result.amountIn);
  const amountOut = normalizeRouteAmount(result.amountOut);
  const profit = isMissingRouteAmount(result.profit) ? amountOut - amountIn : normalizeRouteAmount(result.profit);
  const profitable = typeof result.profitable === "boolean" ? result.profitable : profit > 0n;
  const poolPath = Array.isArray(result.poolPath) && result.poolPath.every((item) => typeof item === "string")
    ? result.poolPath
    : undefined;
  const tokenPath = Array.isArray(result.tokenPath) && result.tokenPath.every((item) => typeof item === "string")
    ? result.tokenPath
    : undefined;
  const hopAmounts = Array.isArray(result.hopAmounts)
    ? result.hopAmounts.map((amount) => normalizeRouteAmount(amount))
    : undefined;
  const routeResult = {
    amountIn,
    amountOut,
    profit,
    profitable,
    totalGas: normalizeRouteGas(result.totalGas),
    poolPath,
    tokenPath,
    hopAmounts,
    hopCount: normalizeExplicitHopCount(result.hopCount),
  };
  const derivedHopCount = getResultHopCount(routeResult);
  return {
    ...routeResult,
    hopCount: derivedHopCount ?? routeResult.hopCount,
  };
}

function mergeCandidateBatch(
  into: Map<string, CandidateEntry>,
  batch: CandidateEntry[],
  routeKeyFromEdges: (startToken: string, edges: ArbPathLike["edges"]) => string,
) {
  for (const entry of batch) {
    const key = routeKeyFromEdges(entry.path.startToken, entry.path.edges);
    const current = into.get(key);
    if (!current || entry.result.profit > current.result.profit) {
      into.set(key, entry);
    }
  }
}

function normaliseCandidateBatch(
  batch: Array<{ path: ArbPathLike; result: RawRouteResult }>,
): CandidateEntry[] {
  return batch.map(({ path, result }) => ({
    path,
    result: toRouteResultLike(result),
  }));
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(Math.floor(concurrency), items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

type SearchDeps = {
  cachedCycles: () => ArbPathLike[];
  topologyDirty: () => boolean;
  refreshCycles: () => Promise<ArbPathLike[] | void>;
  passCount: () => number;
  maxPathsToOptimize: number;
  minProfitWei: bigint;
  flashLoanFeeBps?: bigint;
  stateCache: RouteStateCache;
  log: LoggerFn;
  getCurrentFeeSnapshot: () => Promise<FeeSnapshot>;
  getFreshTokenToMaticRate: (tokenAddress: string) => bigint;
  getRouteFreshness: (path: ArbPathLike) => { ok: boolean; reason?: string };
  getProbeAmountsForToken: (tokenAddress: string) => bigint[];
  evaluatePathsParallel: (
    paths: ArbPathLike[],
    stateCache: RouteStateCache,
    probeAmount: bigint,
    options: Record<string, unknown>,
  ) => Promise<Array<{ path: ArbPathLike; result: RawRouteResult }>>;
  optimizeInputAmount: (
    path: ArbPathLike,
    stateCache: RouteStateCache,
    options: AssessmentOptimizationOptions,
  ) => RouteResultLike | null;
  evaluateCandidatePipeline: (candidates: CandidateEntry[], options: {
    shortlistLimit: number;
    gasPriceWei: bigint;
    getTokenToMaticRate: (tokenAddress: string) => bigint;
    optimizePath: (
      path: ArbPathLike,
      quickResult: RouteResultLike | null | undefined,
      tokenToMaticRate: bigint,
    ) => Promise<RouteResultLike | null> | RouteResultLike | null;
    assessRoute: (path: ArbPathLike, routeResult: RouteResultLike, tokenToMaticRate: bigint) => AssessmentLike;
    optimizeConcurrency?: number;
  }) => Promise<CandidatePipelineResult>;
  partitionFreshCandidates: (candidates: ExecutableCandidate[], getFreshness: (path: ArbPathLike) => { ok: boolean; reason?: string }) => {
    fresh: ExecutableCandidate[];
    stale: Array<{ candidate: ExecutableCandidate; freshness: { reason?: string } }>;
  };
  filterQuarantinedCandidates: <T extends { path: ArbPathLike }>(candidates: T[], source: string) => T[];
  routeCacheUpdate: (candidates: ExecutableCandidate[]) => void;
  routeKeyFromEdges: (startToken: string, edges: ArbPathLike["edges"]) => string;
  getPoolRecord?: (poolAddress: string) => PoolRecord | null | undefined;
  fetchAndCacheStates?: (pools: PoolRecord[], options?: Record<string, unknown>) => Promise<unknown>;
  fmtPath: (path: ArbPathLike) => string;
  fmtProfit: (netWei: bigint, tokenAddr: string) => string;
  onPathsEvaluated: (count: number) => void;
  onCandidateMetrics: (metrics: { candidateCount: number; topCandidates: number; optimizedCandidates: number; profitableRoutes: number }) => void;
  onArbsFound: (count: number) => void;
  workerCount: number;
};

export function createArbSearcher(deps: SearchDeps) {
  async function evaluateCandidatesMultiProbe(paths: ArbPathLike[]) {
    const byStartToken = new Map<string, ArbPathLike[]>();
    for (const path of paths) {
      const token = path.startToken.toLowerCase();
      if (!byStartToken.has(token)) byStartToken.set(token, []);
      byStartToken.get(token)!.push(path);
    }

    const merged = new Map<string, CandidateEntry>();
    const probeTasks: Array<{ startToken: string; tokenPaths: ArbPathLike[]; probeAmount: bigint }> = [];
    let totalPathEvaluations = 0;

    for (const [startToken, tokenPaths] of byStartToken) {
      const probeAmounts = normalizeProbeAmounts(deps.getProbeAmountsForToken(startToken));
      for (const probeAmount of probeAmounts) {
        probeTasks.push({ startToken, tokenPaths, probeAmount });
        totalPathEvaluations += tokenPaths.length;
      }
    }

    const concurrency = Math.max(1, deps.workerCount || 1);
    const evaluatedBatches = await mapConcurrent(
      probeTasks,
      concurrency,
      async ({ tokenPaths, probeAmount }) => deps.evaluatePathsParallel(
        tokenPaths,
        deps.stateCache,
        probeAmount,
        { workerCount: deps.workerCount },
      ),
    );

    // Merge in deterministic task-construction order so equal-profit duplicate
    // routes retain the same winner as the previous sequential implementation.
    for (const batch of evaluatedBatches) {
      mergeCandidateBatch(
        merged,
        normaliseCandidateBatch(batch),
        deps.routeKeyFromEdges,
      );
    }

    deps.log("[runner] Multi-probe evaluation complete", "debug", {
      event: "multi_probe_summary",
      startTokens: byStartToken.size,
      totalProbeRuns: probeTasks.length,
      totalPathEvaluations,
      mergedCandidates: merged.size,
    });

    return {
      candidates: [...merged.values()].sort((a, b) => {
        if (b.result.profit > a.result.profit) return 1;
        if (b.result.profit < a.result.profit) return -1;
        return 0;
      }),
      totalProbeRuns: probeTasks.length,
      totalPathEvaluations,
    };
  }

  return async function findArbs(): Promise<ExecutableCandidate[]> {
    if (deps.topologyDirty() || deps.cachedCycles().length === 0) await deps.refreshCycles();
    const cycles = deps.cachedCycles();
    if (cycles.length === 0) {
      deps.onPathsEvaluated(0);
      deps.onCandidateMetrics({ candidateCount: 0, topCandidates: 0, optimizedCandidates: 0, profitableRoutes: 0 });
      return [];
    }

    let scanSelection = selectFreshUniqueScanPaths(cycles, deps);
    if (scanSelection.duplicatePaths > 0 || scanSelection.stalePaths > 0) {
      deps.log("[runner] Pruned routes before simulation", "debug", {
        event: "scan_prune_routes",
        cachedPaths: cycles.length,
        duplicatePaths: scanSelection.duplicatePaths,
        stalePaths: scanSelection.stalePaths,
        scanPaths: scanSelection.paths.length,
        staleReasons: scanSelection.staleReasons,
      });
    }

    if (scanSelection.paths.length === 0) {
      try {
        if (await refreshStaleScanRoutes(cycles, deps)) {
          const refreshedSelection = selectFreshUniqueScanPaths(cycles, deps);
          deps.log("[runner] Stale cached route refresh complete", "info", {
            event: "scan_stale_route_refresh_complete",
            cachedPaths: cycles.length,
            stalePathsBefore: scanSelection.stalePaths,
            freshPathsAfter: refreshedSelection.paths.length,
            stalePathsAfter: refreshedSelection.stalePaths,
            staleReasonsAfter: refreshedSelection.staleReasons,
          });
          scanSelection = refreshedSelection;
        }
      } catch (err) {
        deps.log("[runner] Stale cached route refresh failed", "warn", {
          event: "scan_stale_route_refresh_error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (scanSelection.paths.length === 0) {
      deps.onPathsEvaluated(0);
      deps.onCandidateMetrics({ candidateCount: 0, topCandidates: 0, optimizedCandidates: 0, profitableRoutes: 0 });
      deps.log("Skipped arb scan because no cached routes have fresh state", "info", {
        event: "scan_skip_no_fresh_routes",
        activity: "No fresh routes",
        activityDetail: "Cached routes are stale or duplicated before simulation",
        progressLabel: "scan",
        progressCompleted: 3,
        progressTotal: 3,
        progressUnit: "steps",
        cachedPaths: cycles.length,
        duplicatePaths: scanSelection.duplicatePaths,
        stalePaths: scanSelection.stalePaths,
        staleReasons: scanSelection.staleReasons,
      });
      return [];
    }

    deps.log("[runner] Simulating fresh route batch", "info", {
      event: "scan_evaluation_start",
      activity: "Simulating routes",
      activityDetail: `${scanSelection.paths.length} fresh path(s), ${cycles.length} cached path(s)`,
      progressLabel: "scan",
      progressCompleted: 1,
      progressTotal: 3,
      progressUnit: "steps",
      paths: scanSelection.paths.length,
      cachedPaths: cycles.length,
      duplicatePaths: scanSelection.duplicatePaths,
      stalePaths: scanSelection.stalePaths,
    });
    const { candidates, totalProbeRuns, totalPathEvaluations } = await evaluateCandidatesMultiProbe(scanSelection.paths);
    deps.onPathsEvaluated(totalPathEvaluations);

    // Fix #4: Check fee snapshot BEFORE expensive candidate pipeline, not after.
    // Previously this check happened after evaluateCandidatesMultiProbe, wasting
    // full multi-probe simulation + scoring when gas data was stale.
    const feeSnapshot = await deps.getCurrentFeeSnapshot();
    if (!feeSnapshot?.maxFee) {
      deps.onCandidateMetrics({ candidateCount: candidates.length, topCandidates: 0, optimizedCandidates: 0, profitableRoutes: 0 });
      deps.log("Skipping candidate optimization because the fee snapshot is stale or unavailable", "warn", {
        event: "scan_skip_stale_gas",
        activity: "Waiting for gas data",
        activityDetail: "Skipping candidate optimization because fee data is stale or unavailable",
        progressLabel: "scan",
        progressCompleted: 3,
        progressTotal: 3,
        progressUnit: "steps",
        candidates: candidates.length,
      });
      return [];
    }
    const gasPriceWei = feeSnapshot.effectiveGasPriceWei ?? feeSnapshot.maxFee;

    deps.log(
      candidates.length === 0
        ? `Scanned ${scanSelection.paths.length} paths — no candidates above fee threshold`
        : `Scanned ${scanSelection.paths.length} paths → ${candidates.length} candidates`,
      "info",
      {
        event: "scan_summary",
        activity: candidates.length === 0 ? "Routing scan complete" : "Selecting route candidates",
        activityDetail: `${candidates.length} candidate(s) from ${scanSelection.paths.length} scanned path(s)`,
        progressLabel: "scan",
        progressCompleted: candidates.length === 0 ? 3 : 2,
        progressTotal: 3,
        progressUnit: "steps",
        paths: scanSelection.paths.length,
        cachedPaths: cycles.length,
        duplicatePaths: scanSelection.duplicatePaths,
        stalePaths: scanSelection.stalePaths,
        totalProbeRuns,
        totalPathEvaluations,
        candidates: candidates.length,
      },
    );

    if (candidates.length === 0) {
      deps.onCandidateMetrics({ candidateCount: 0, topCandidates: 0, optimizedCandidates: 0, profitableRoutes: 0 });
      return [];
    }

    deps.log("[runner] Optimizing candidate shortlist", "info", {
      event: "candidate_optimization_start",
      activity: "Optimizing candidates",
      activityDetail: `${candidates.length} candidate(s), max ${deps.maxPathsToOptimize} optimized`,
      progressLabel: "scan",
      progressCompleted: 2,
      progressTotal: 3,
      progressUnit: "steps",
      candidates: candidates.length,
      maxPathsToOptimize: deps.maxPathsToOptimize,
    });
    const {
      shortlisted: topCandidates,
      optimizedCandidates,
      profitable,
      assessmentSummary,
    } = await deps.evaluateCandidatePipeline(candidates, {
      shortlistLimit: deps.maxPathsToOptimize,
      gasPriceWei,
      getTokenToMaticRate: deps.getFreshTokenToMaticRate,
      optimizePath: (path: ArbPathLike, quickResult: RouteResultLike | null | undefined, tokenToMaticRate: bigint) =>
        deps.optimizeInputAmount(
          path,
          deps.stateCache,
          getAssessmentOptimizationOptions(path, quickResult, gasPriceWei, tokenToMaticRate, {
            minProfitWei: deps.minProfitWei,
            flashLoanFeeBps: deps.flashLoanFeeBps,
          }),
        ),
      assessRoute: (path: ArbPathLike, routeResult: RouteResultLike, tokenToMaticRate: bigint) =>
        assessRouteResult(path, routeResult, gasPriceWei, tokenToMaticRate, {
          minProfitWei: deps.minProfitWei,
          flashLoanFeeBps: deps.flashLoanFeeBps,
        }),
      optimizeConcurrency: deps.workerCount,
    });

    const { fresh: freshProfitable, stale: staleProfitable } = deps.partitionFreshCandidates(
      profitable,
      (candidatePath: ArbPathLike) => deps.getRouteFreshness(candidatePath),
    );
    if (staleProfitable.length > 0) {
      deps.log("[runner] Skipping stale profitable routes from scan", "debug", {
        event: "find_arbs_skip_stale",
        staleRoutes: staleProfitable.length,
        reasons: [...new Set(staleProfitable.map(({ freshness }) => freshness.reason).filter(Boolean))].slice(0, 3),
      });
    }

    const eligibleProfitable = deps.filterQuarantinedCandidates(freshProfitable, "find_arbs");
    deps.onCandidateMetrics({
      candidateCount: candidates.length,
      topCandidates: topCandidates.length,
      optimizedCandidates,
      profitableRoutes: eligibleProfitable.length,
    });

    if (eligibleProfitable.length > 0) {
      deps.onArbsFound(eligibleProfitable.length);
      deps.routeCacheUpdate(eligibleProfitable);
      for (const { path, assessment } of eligibleProfitable) {
        const net = assessment.netProfitAfterGas ?? assessment.netProfit ?? 0n;
        deps.log(
          `  ↳ ${deps.fmtPath(path)}  net ${deps.fmtProfit(net, path.startToken)}`,
          "info",
          {
            event: "profitable_route",
            route: deps.fmtPath(path),
            hopCount: path.hopCount,
            netProfit: net.toString(),
          },
        );
      }
    }

    if (eligibleProfitable.length === 0 && assessmentSummary && assessmentSummary.rejected > 0) {
      const topReasons = Object.entries(assessmentSummary.rejectReasons)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([reason, count]) => `${reason}:${count}`)
        .join(", ");
      deps.log(`[runner] 0 profitable — rejected ${assessmentSummary.rejected}/${assessmentSummary.assessed} (${topReasons})`, "info", {
        event: "candidate_optimization_summary",
        activity: "Candidate optimization complete",
        activityDetail: `${eligibleProfitable.length} profitable route(s) from ${candidates.length} candidate(s)`,
        progressLabel: "scan",
        progressCompleted: 3,
        progressTotal: 3,
        progressUnit: "steps",
        candidates: candidates.length,
        topCandidates: topCandidates.length,
        optimizedCandidates,
        skippedOptimization: topCandidates.length - optimizedCandidates,
        profitableRoutes: eligibleProfitable.length,
        assessmentSummary,
      });
    } else {
      deps.log("[runner] Candidate optimization pass complete", "debug", {
        event: "candidate_optimization_summary",
        activity: "Candidate optimization complete",
        activityDetail: `${eligibleProfitable.length} profitable route(s) from ${candidates.length} candidate(s)`,
        progressLabel: "scan",
        progressCompleted: 3,
        progressTotal: 3,
        progressUnit: "steps",
        candidates: candidates.length,
        topCandidates: topCandidates.length,
        optimizedCandidates,
        skippedOptimization: topCandidates.length - optimizedCandidates,
        profitableRoutes: eligibleProfitable.length,
        assessmentSummary,
      });
    }

    eligibleProfitable.sort(compareAssessmentProfit);
    return eligibleProfitable;
  };
}
