import type { FoundCycle, PipelineOptions } from "./types.ts";
import type { RouteSimulationResult, RouteStateCache } from "../core/types/route.ts";
import {
  simulateRoute,
  simulateRouteMinimal,
  buildSimulationEdges,
  simulateHop,
  getEffectivePriceImpact,
  getTestAmount,
} from "./simulator.ts";
import type { SimulationEdge } from "./types.ts";
import { computeProfit, computeProfitCore } from "../core/assessment/profit.ts";
import type { ProfitAssessment } from "../core/types/execution.ts";
import type { PoolState } from "../core/types/pool.ts";

/**
 * Pipeline evaluation (ternary search + profit assessment).
 * Because the system is flash-loan-only, the optimal `amountIn` chosen by ternary search
 * directly determines the flash loan size passed to the executor. Flash fees are applied
 * inside computeProfit based on the explicitly-provided flashLoanSource.
 */

const CONVERGENCE_DIVISOR = 10000n;

export interface PipelineResult {
  profitable: Array<{
    cycle: FoundCycle;
    result: RouteSimulationResult;
    assessment: ProfitAssessment;
  }>;
  attempted: number;
  profitableCount: number;
  simulated: number;
  pruned: number;
  noRate: number;
  maxGrossProfitMatic?: bigint;
}

function getEffectivePriceImpactForCycle(
  cycle: FoundCycle,
  amount: bigint,
  stateCache: RouteStateCache,
  maxImpactThreshold: number = 0.15,
): boolean {
  let currentAmount = amount;
  for (const edge of cycle.edges) {
    const impact = getEffectivePriceImpact(edge, currentAmount, stateCache);
    if (impact > maxImpactThreshold) {
      return true;
    }
    const poolAddr = edge.poolAddress.toLowerCase();
    const state = (stateCache.get(poolAddr) ?? edge.stateRef) as PoolState | undefined;
    if (!state) return false;
    const simEdge: SimulationEdge = {
      poolAddress: edge.poolAddress,
      tokenIn: edge.tokenIn,
      tokenOut: edge.tokenOut,
      protocol: edge.protocol,
      zeroForOne: edge.zeroForOne,
      tokenInIdx: edge.tokenInIdx,
      tokenOutIdx: edge.tokenOutIdx,
      fee: edge.feeBps,
      stateRef: state,
    };
    try {
      const result = simulateHop(simEdge, currentAmount, stateCache);
      currentAmount = result.amountOut;
    } catch (_err: unknown) {
      return true;
    }
  }
  return false;
}

// Reusable holder to reduce per-probe allocations during ternary search
interface MinimalEvalHolder {
  grossProfitMatic: bigint | null;
  netProfitAfterGasMaticWei: bigint;
  assessment?: ProfitAssessment;
}

function evaluateAmount(
  cycle: FoundCycle,
  amount: bigint,
  stateCache: RouteStateCache,
  options: PipelineOptions,
  skipImpactCheck: boolean = false,
  minimalForSearch: boolean = false,
  prebuiltSimEdges?: SimulationEdge[],
  outHolder?: MinimalEvalHolder,
): { result: RouteSimulationResult | null; assessment: ProfitAssessment | null; grossProfitMatic: bigint | null } {
  if (!skipImpactCheck) {
    const maxImpact = options.maxPriceImpactThreshold ?? 0.15;
    if (getEffectivePriceImpactForCycle(cycle, amount, stateCache, maxImpact)) {
      return { result: null, assessment: null, grossProfitMatic: null };
    }
  }

  try {
    let simProfit: bigint;
    let simGas: number;
    let simAmountIn = amount;
    let fullResult: RouteSimulationResult | null = null;

    if (minimalForSearch) {
      // Hot path during ternary search — avoid allocating full path/hop arrays on every probe
      const minimal = simulateRouteMinimal(cycle.edges, amount, stateCache, undefined, prebuiltSimEdges);
      simProfit = minimal.profit;
      simGas = minimal.totalGas;

      // outHolder writing happens after core numbers are computed below
    } else {
      fullResult = simulateRoute(cycle.edges, amount, stateCache, undefined, prebuiltSimEdges);
      simProfit = fullResult.profit;
      simGas = fullResult.totalGas;
      simAmountIn = fullResult.amountIn;
    }

    const startRate = options.tokenToMaticRates.get(cycle.startToken.toLowerCase()) ?? 0n;
    if (startRate === 0n) {
      return { result: null, assessment: null, grossProfitMatic: null };
    }

    // Extreme loss/gain check is skipped in minimal search mode (safety net, not correctness)
    if (!minimalForSearch && fullResult) {
      for (let i = 0; i < cycle.edges.length; i++) {
        const edge = cycle.edges[i];
        const rateIn = options.tokenToMaticRates.get(edge.tokenIn.toLowerCase()) ?? 0n;
        const rateOut = options.tokenToMaticRates.get(edge.tokenOut.toLowerCase()) ?? 0n;

        if (rateIn > 0n && rateOut > 0n) {
          const valIn = (fullResult.hopAmounts[i] * rateIn) / 10n ** 18n;
          const valOut = (fullResult.hopAmounts[i + 1] * rateOut) / 10n ** 18n;

          const isExtremeLoss = valOut < valIn / 2n;
          const isExtremeGain = valOut > valIn * 5n;

          if ((isExtremeLoss || isExtremeGain) && valIn > 10n ** 15n) {
            return { result: null, assessment: null, grossProfitMatic: null };
          }
        }
      }
    }

    let assessment: ProfitAssessment | null = null;
    let netProfitAfterGasMaticWei = 0n;

    if (minimalForSearch) {
      // Numeric-only path: avoid full ProfitAssessment allocation during every ternary probe
      const core = computeProfitCore({
        grossProfitInTokens: simProfit,
        amountInTokens: simAmountIn,
        gasUnits: simGas,
        gasPriceWei: options.gasPriceWei,
        tokenToMaticRate: startRate,
        hopCount: cycle.edges.length,
        minProfitMaticWei: options.minProfitMaticWei ?? 0n,
        flashLoanSource: options.flashLoanSource,
        slippageBps: options.slippageBps,
        revertRiskBps: options.revertRiskBps,
      });
      netProfitAfterGasMaticWei = core.netProfitAfterGasMaticWei;

      // We still need a minimal assessment object for the "best" tracking logic.
      // This is much smaller pressure than the full object every single iteration.
      assessment = {
        shouldExecute: netProfitAfterGasMaticWei >= (options.minProfitMaticWei ?? 0n),
        grossProfit: simProfit,
        gasCostWei: core.gasCostWei,
        gasCostInTokens: core.gasCostInTokens,
        flashLoanFee: core.flashFee,
        slippageDeduction: core.slippage,
        revertPenalty: core.revert,
        netProfit: core.netProfitInTokens,
        netProfitAfterGas: core.netProfitAfterGasInTokens,
        netProfitAfterGasMaticWei,
        roi: core.roi,
      } as ProfitAssessment;
    } else {
      assessment = computeProfit({
        grossProfitInTokens: simProfit,
        amountInTokens: simAmountIn,
        gasUnits: simGas,
        gasPriceWei: options.gasPriceWei,
        tokenToMaticRate: startRate,
        hopCount: cycle.edges.length,
        minProfitMaticWei: options.minProfitMaticWei ?? 0n,
        flashLoanSource: options.flashLoanSource,
      });
      netProfitAfterGasMaticWei = assessment.netProfitAfterGasMaticWei;
    }

    const grossMatic = (simProfit * startRate) / 10n ** 18n;

    if (minimalForSearch && outHolder) {
      outHolder.grossProfitMatic = grossMatic;
      outHolder.netProfitAfterGasMaticWei = netProfitAfterGasMaticWei;
      outHolder.assessment = assessment ?? undefined;
    }

    return { result: fullResult, assessment, grossProfitMatic: grossMatic };
  } catch (_err: unknown) {
    return { result: null, assessment: null, grossProfitMatic: null };
  }
}

export async function evaluatePipeline(
  cycles: FoundCycle[],
  stateCache: RouteStateCache,
  options: PipelineOptions,
): Promise<PipelineResult> {
  const profitable: PipelineResult["profitable"] = [];
  let attempted = 0;
  let simulated = 0;
  let pruned = 0;
  let noRate = 0;
  let maxGrossMatic: bigint | undefined = undefined;

  const CONCURRENCY = options.concurrency ?? 50;
  const batches: FoundCycle[][] = [];
  for (let i = 0; i < cycles.length; i += CONCURRENCY) {
    batches.push(cycles.slice(i, i + CONCURRENCY));
  }

  for (const batch of batches) {
    if (profitable.length >= 10) break;

    const results = await Promise.all(
      batch.map(async (cycle) => {
        attempted++;
        try {
          const tokens = [cycle.startToken, ...cycle.edges.map((e) => e.tokenOut)];
          const hasAllRates = tokens.every((t) => (options.tokenToMaticRates.get(t.toLowerCase()) ?? 0n) > 0n);
          if (!hasAllRates) return { type: "noRate" as const, cycle };

          // Pre-build SimulationEdge templates once per cycle.
          // This is the key allocation reduction for the entire ternary search:
          // every simulate* call during probing now reuses these instead of allocating per hop.
          const prebuiltSimEdges = buildSimulationEdges(cycle.edges, stateCache);

          const baseAmount = getTestAmount(cycle.startToken, options.tokenMetas);
          const low = baseAmount / 5000n;
          if (low === 0n) return { type: "pruned" as const, cycle };
          const high = baseAmount;
          const ternaryIters = options.ternarySearchIterations ?? 15;
          const evalLow = evaluateAmount(cycle, low, stateCache, options, false, true, prebuiltSimEdges); // minimal for initial probe
          if (!evalLow.result || evalLow.grossProfitMatic === null || evalLow.grossProfitMatic <= 0n) {
            return { type: (evalLow.grossProfitMatic === null ? "noRate" : "pruned") as "noRate" | "pruned", cycle };
          }

          let left = low;
          let right = high;
          let bestResult: RouteSimulationResult | null = null;
          let bestAssessment: ProfitAssessment | null = null;
          let bestProfit = -1_000_000_000_000_000_000_000_000_000_000n;
          let bestGrossMatic = 0n;
          let bestAmount: bigint = low; // track the amount that produced the current best (for final full sim)

          // Object pooling: two reusable holders for the m1/m2 probes to cut per-iteration allocations
          const probe1Holder: MinimalEvalHolder = { grossProfitMatic: null, netProfitAfterGasMaticWei: 0n };
          const probe2Holder: MinimalEvalHolder = { grossProfitMatic: null, netProfitAfterGasMaticWei: 0n };

          for (let iter = 0; iter < ternaryIters; iter++) {
            const range = right - left;
            if (range <= baseAmount / CONVERGENCE_DIVISOR) {
              const mid = left + range / 2n;
              const { result, assessment, grossProfitMatic } = evaluateAmount(
                cycle,
                mid,
                stateCache,
                options,
                false,
                true,
                prebuiltSimEdges,
              ); // minimal on convergence too

              if (grossProfitMatic && grossProfitMatic > bestGrossMatic) {
                bestGrossMatic = grossProfitMatic;
              }

              if (result && assessment && assessment.netProfitAfterGasMaticWei > bestProfit) {
                bestResult = result; // will be null in minimal mode
                bestAssessment = assessment;
                bestProfit = assessment.netProfitAfterGasMaticWei;
                bestAmount = mid;
              }
              break;
            }

            const m1 = left + range / 3n;
            const m2 = right - range / 3n;
            const eval1 = evaluateAmount(cycle, m1, stateCache, options, false, true, prebuiltSimEdges, probe1Holder); // minimal probe + pooled holder
            const eval2 = evaluateAmount(cycle, m2, stateCache, options, false, true, prebuiltSimEdges, probe2Holder); // minimal probe + pooled holder

            if (eval1.grossProfitMatic && eval1.grossProfitMatic > bestGrossMatic) {
              bestGrossMatic = eval1.grossProfitMatic;
            }
            if (eval2.grossProfitMatic && eval2.grossProfitMatic > bestGrossMatic) {
              bestGrossMatic = eval2.grossProfitMatic;
            }

            const profit1 = eval1.assessment?.netProfitAfterGasMaticWei ?? -1_000_000_000_000_000_000_000_000_000_000n;
            const profit2 = eval2.assessment?.netProfitAfterGasMaticWei ?? -1_000_000_000_000_000_000_000_000_000_000n;

            if (profit1 > bestProfit && eval1.result && eval1.assessment) {
              bestResult = eval1.result;
              bestAssessment = eval1.assessment;
              bestProfit = profit1;
              bestAmount = m1;
            }
            if (profit2 > bestProfit && eval2.result && eval2.assessment) {
              bestResult = eval2.result;
              bestAssessment = eval2.assessment;
              bestProfit = profit2;
              bestAmount = m2;
            }

            if (profit1 < 0 && profit2 < 0) {
              if (eval1.result === null && eval2.result === null) {
                right = m1;
              } else {
                if (profit1 > profit2) right = m2;
                else left = m1;
              }
            } else if (profit1 > profit2) {
              right = m2;
            } else {
              left = m1;
            }
          }

          // After search: if we only have minimal results for the winner, do one final full simulation
          // to capture the rich RouteSimulationResult needed downstream. This is the key allocation win:
          // 20-30 cheap minimal probes + 1 full sim per cycle instead of 20-30 full simulations.
          if (bestResult === null && bestAssessment && bestProfit > -1_000_000_000_000_000_000_000_000_000_000n) {
            const full = evaluateAmount(cycle, bestAmount, stateCache, options, true, false, prebuiltSimEdges);
            if (full.result && full.assessment) {
              bestResult = full.result;
              bestAssessment = full.assessment;
            }
          }

          return { type: "success" as const, bestResult, bestAssessment, bestGrossMatic, cycle };
        } catch (_err: unknown) {
          return { type: "error" as const, cycle };
        }
      }),
    );

    type EvalSuccess = { type: "success"; bestResult: RouteSimulationResult; bestAssessment: ProfitAssessment; bestGrossMatic: bigint; cycle: FoundCycle };
    const sortedResults = results
      .filter((r): r is EvalSuccess => r.type === "success")
      .sort((a, b) => Number(b.bestGrossMatic - a.bestGrossMatic));

    if (sortedResults.length > 0 && sortedResults[0].bestGrossMatic > 0n) {
      const top = sortedResults[0];
      if (top.bestAssessment && top.bestResult) {
        if (top.bestGrossMatic > 10n * 10n ** 18n) {
          const path = top.bestResult.poolPath.join(" -> ");
          const roi = top.bestAssessment.roi / 1_000_000;
          if (options.logger) {
            options.logger.debug?.(
              {
                grossMatic: (top.bestGrossMatic / 10n ** 15n).toString() + "mMATIC",
                roi,
                path,
                reason: top.bestAssessment.rejectReason,
              },
              "Top outlier detected in pass",
            );
          }
        }
      }
    }

    for (const res of results) {
      if (res.type === "noRate") noRate++;
      else if (res.type === "pruned") pruned++;
      else if (res.type === "success" && "cycle" in res) {
        simulated++;
        const cycleForRes = res.cycle;
        if (res.bestGrossMatic > 0n && (maxGrossMatic === undefined || res.bestGrossMatic > maxGrossMatic)) {
          maxGrossMatic = res.bestGrossMatic;
        }
        if (res.bestResult && res.bestAssessment && res.bestAssessment.shouldExecute) {
          if (options.logger) {
            options.logger.info?.(
              {
                routeKey: cycleForRes.id,
                profit: res.bestAssessment.netProfitAfterGasMaticWei.toString(),
                roi: res.bestAssessment.roi / 1_000_000,
                path: res.bestResult.poolPath.join(" -> "),
              },
              "Evaluating profitable candidate",
            );
          }
          profitable.push({ cycle: cycleForRes, result: res.bestResult, assessment: res.bestAssessment });
        }
      }
    }

    if (options.onProgress) {
      options.onProgress(attempted, cycles.length, profitable.length);
    }
  }

  return {
    profitable,
    attempted,
    profitableCount: profitable.length,
    simulated,
    pruned,
    noRate,
    maxGrossProfitMatic: maxGrossMatic,
  };
}
