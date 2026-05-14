import {
  assessRouteResult,
  compareAssessmentProfit,
  getAssessmentOptimizationOptions,
  type AssessmentOptimizationOptions,
  type ArbPathLike,
  type ExecutableCandidate,
  type RouteResultLike,
} from "./assessment.ts";
import type { RouteStateCache } from "../routing/simulation_types.ts";

type RevalidationDeps = {
  getAffectedRoutes: (
    changedPools: Set<string>,
  ) => Array<{ path: ArbPathLike; result: RouteResultLike }> | Promise<Array<{ path: ArbPathLike; result: RouteResultLike }>>;
  routeKeyFromEdges: (startToken: string, edges: ArbPathLike["edges"]) => string;
  stateCache: RouteStateCache;
  testAmountWei: bigint;
  minProfitWei: bigint;
  flashLoanFeeBps?: bigint;
  maxExecutionBatch: number;
  log: (msg: string, level?: "fatal" | "error" | "warn" | "info" | "debug" | "trace", meta?: unknown) => void;
  getCurrentFeeSnapshot: () => Promise<{ maxFee?: bigint; effectiveGasPriceWei?: bigint } | null>;
  getFreshTokenToMaticRate: (tokenAddress: string) => bigint;
  getRouteFreshness: (path: ArbPathLike) => { ok: boolean; reason?: string };
  simulateRoute: (path: ArbPathLike, amountIn: bigint, stateCache: RouteStateCache) => RouteResultLike;
  optimizeInputAmount: (path: ArbPathLike, stateCache: RouteStateCache, options: AssessmentOptimizationOptions) => RouteResultLike | null;
  routeCacheUpdate: (candidates: ExecutableCandidate[]) => void;
  routeCacheRemove?: (path: ArbPathLike, reason: string) => number | void;
  filterQuarantinedCandidates: <T extends { path: ArbPathLike }>(candidates: T[], source: string) => T[];
  executeBatchIfIdle: (candidates: ExecutableCandidate[], source?: string) => Promise<unknown>;
};

export function createRouteRevalidator(deps: RevalidationDeps) {
  return async function revalidateCachedRoutes(changedPools: Set<string>) {
    const affected = dedupeAffectedRoutes(await deps.getAffectedRoutes(changedPools), deps.routeKeyFromEdges);
    if (affected.length === 0) return;

    deps.log(`[fast-revalidate] ${affected.length} cached route(s) for ${changedPools.size} changed pool(s)`, "debug", {
      event: "fast_revalidate_start",
      affectedRoutes: affected.length,
      changedPools: changedPools.size,
    });

    const feeSnapshot = await deps.getCurrentFeeSnapshot();
    if (!feeSnapshot?.maxFee) {
      deps.log("[fast-revalidate] Skipping because the fee snapshot is stale or unavailable", "warn", {
        event: "fast_revalidate_skip_stale_gas",
        affectedRoutes: affected.length,
      });
      return;
    }
    const gasPriceWei = feeSnapshot.effectiveGasPriceWei ?? feeSnapshot.maxFee;

    const profitable: ExecutableCandidate[] = [];
    let quickRejected = 0;
    let optimizedRoutes = 0;
    let missingTokenRates = 0;
    const rejectReasons: Record<string, number> = {};
    const tokenRateCache = new Map<string, bigint>();
    const recordReject = (reason: string | undefined) => {
      const key = reason && reason.trim() ? reason : "assessment_rejected";
      rejectReasons[key] = (rejectReasons[key] ?? 0) + 1;
      return key;
    };
    const evictRejectedRoute = (path: ArbPathLike, reason: string) => {
      const removed = deps.routeCacheRemove?.(path, reason) ?? 0;
      if (removed > 0) {
        deps.log("[fast-revalidate] Evicted rejected cached route", "debug", {
          event: "fast_revalidate_cache_evict_rejected",
          reason,
          removed,
          hopCount: path.hopCount,
        });
      }
    };
    const tokenRateFor = (tokenAddress: string) => {
      const key = String(tokenAddress ?? "").toLowerCase();
      const cached = tokenRateCache.get(key);
      if (cached != null) return cached;
      const rate = deps.getFreshTokenToMaticRate(tokenAddress);
      tokenRateCache.set(key, rate);
      return rate;
    };
    for (const { path, result: prev } of affected) {
      const freshness = deps.getRouteFreshness(path);
      if (!freshness.ok) {
        deps.log(`[fast-revalidate] Skipping stale route: ${freshness.reason}`, "debug", {
          event: "fast_revalidate_skip_stale",
          reason: freshness.reason,
          hopCount: path.hopCount,
        });
        continue;
      }

      const tokenToMaticRate = tokenRateFor(path.startToken);
      if (tokenToMaticRate <= 0n) {
        missingTokenRates++;
        continue;
      }

      const quickResult = deps.simulateRoute(path, prev?.amountIn ?? deps.testAmountWei, deps.stateCache);
      const quickAssessment = assessRouteResult(path, quickResult, gasPriceWei, tokenToMaticRate, {
        minProfitWei: deps.minProfitWei,
        flashLoanFeeBps: deps.flashLoanFeeBps,
      });

      let optimized = quickResult;
      if (quickAssessment.shouldExecute || quickResult.profit > 0n) {
        optimizedRoutes++;
        optimized =
          deps.optimizeInputAmount(
            path,
            deps.stateCache,
            getAssessmentOptimizationOptions(path, prev, gasPriceWei, tokenToMaticRate, {
              minProfitWei: deps.minProfitWei,
              flashLoanFeeBps: deps.flashLoanFeeBps,
            }),
          ) || quickResult;
      }
      if (!optimized?.profitable) {
        if (!quickAssessment.shouldExecute) {
          quickRejected++;
          const reason = recordReject(quickAssessment.rejectReason);
          evictRejectedRoute(path, reason);
        }
        continue;
      }

      const assessment = assessRouteResult(path, optimized, gasPriceWei, tokenToMaticRate, {
        minProfitWei: deps.minProfitWei,
        flashLoanFeeBps: deps.flashLoanFeeBps,
      });
      if (assessment.shouldExecute) {
        profitable.push({ path, result: optimized, assessment });
      } else if (!quickAssessment.shouldExecute) {
        quickRejected++;
        const reason = recordReject(assessment.rejectReason || quickAssessment.rejectReason);
        evictRejectedRoute(path, reason);
      } else {
        const reason = recordReject(assessment.rejectReason);
        evictRejectedRoute(path, reason);
      }
    }

    deps.log("[runner] Fast revalidation summary", "debug", {
      event: "fast_revalidate_summary",
      affectedRoutes: affected.length,
      quickRejected,
      optimizedRoutes,
      missingTokenRates,
      rejectReasons,
      profitableRoutes: profitable.length,
    });

    const eligibleProfitable = deps.filterQuarantinedCandidates(profitable, "fast_revalidate");

    if (eligibleProfitable.length > 0) {
      deps.routeCacheUpdate(eligibleProfitable);
    }

    if (eligibleProfitable.length > 0) {
      eligibleProfitable.sort(compareAssessmentProfit);
      const executionBatch = eligibleProfitable.slice(0, deps.maxExecutionBatch);
      deps.log(`[fast-revalidate] ${eligibleProfitable.length} opportunity(ies) — executing ${executionBatch.length}`, "info", {
        event: "fast_revalidate_execute",
        profitableRoutes: eligibleProfitable.length,
        executingRoutes: executionBatch.length,
      });
      await deps.executeBatchIfIdle(executionBatch, "fast_revalidate");
    }
  };
}

function dedupeAffectedRoutes(
  affected: Array<{ path: ArbPathLike; result: RouteResultLike }>,
  routeKeyFromEdges: (startToken: string, edges: ArbPathLike["edges"]) => string,
) {
  const unique = new Map<string, { path: ArbPathLike; result: RouteResultLike }>();
  for (const route of affected) {
    const key = routeKeyFromEdges(route.path.startToken, route.path.edges);
    const current = unique.get(key);
    if (!current || route.result.profit > current.result.profit) {
      unique.set(key, route);
    }
  }
  return [...unique.values()];
}
