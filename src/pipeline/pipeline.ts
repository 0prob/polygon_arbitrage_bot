import type { FoundCycle, PipelineOptions, PipelineResult, SimulationEdge } from "./types.ts";
import type { RouteSimulationResult, RouteStateCache } from "../core/types/route.ts";
import {
  simulateRoute,
  simulateRouteMinimal,
  simulateMinimalWithImpactCheck,
  buildSimulationEdges,
  computeSpotPrice,
} from "./simulator.ts";
import { getDynamicSearchBounds } from "./finder.ts";
import { computeProfit, computeProfitCore, tokensToMaticWei } from "../core/assessment/profit.ts";
import type { ProfitAssessment } from "../core/types/execution.ts";
import type { PoolState } from "../core/types/pool.ts";
import type { PendingStateOverlay } from "../core/types/overlay.ts";
import { solveV2Optimal } from "../core/math/uniswap_v2_solver.ts";
import { solveBrentOptimal } from "../core/math/hybrid_solver.ts";

/**
 * Pipeline evaluation (ternary search + profit assessment).
 * Because the system is flash-loan-only, the optimal `amountIn` chosen by ternary search
 * directly determines the flash loan size passed to the executor. Flash fees are applied
 * inside computeProfit based on the explicitly-provided flashLoanSource.
 */

// Reusable holder to reduce per-probe allocations during ternary search
interface MinimalEvalHolder {
  grossProfitMatic: bigint | null;
  netProfitAfterGasMaticWei: bigint;
  assessment: ProfitAssessment | null;
  result: RouteSimulationResult | null;
  core?: any;
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
  overlay?: PendingStateOverlay,
  startRateOverride?: bigint,
): { result: RouteSimulationResult | null; assessment: ProfitAssessment | null; grossProfitMatic: bigint | null } {
  try {
    let simProfit: bigint;
    let simGas: number;
    let simAmountIn = amount;
    let fullResult: RouteSimulationResult | null = null;

    if (minimalForSearch) {
      if (skipImpactCheck) {
        const minimal = simulateRouteMinimal(cycle.edges, amount, stateCache, prebuiltSimEdges, overlay);
        simProfit = minimal.profit;
        simGas = minimal.totalGas;
      } else {
        const maxImpact = options.maxPriceImpactThreshold ?? 0.15;
        const combined = simulateMinimalWithImpactCheck(cycle.edges, amount, stateCache, prebuiltSimEdges, maxImpact, overlay);
        if (!combined.success) return { result: null, assessment: null, grossProfitMatic: null };
        simProfit = combined.profit;
        simGas = combined.totalGas;
      }
    } else {
      fullResult = simulateRoute(cycle.edges, amount, stateCache, prebuiltSimEdges, overlay);
      simProfit = fullResult.profit;
      simGas = fullResult.totalGas;
      simAmountIn = fullResult.amountIn;

      if (!skipImpactCheck && prebuiltSimEdges) {
        const maxImpact = options.maxPriceImpactThreshold ?? 0.15;
        for (let i = 0; i < prebuiltSimEdges.length; i++) {
          const simEdge = prebuiltSimEdges[i];
          const state = simEdge.stateRef as PoolState | undefined;
          if (!state) return { result: null, assessment: null, grossProfitMatic: null };

          const spotPrice = computeSpotPrice(simEdge.normalizedProtocol, simEdge.zeroForOne, simEdge.tokenInIdx, simEdge.tokenOutIdx, state);
          if (spotPrice > 0 && fullResult.hopAmounts[i] > 0n) {
            const realizedPrice = Number(fullResult.hopAmounts[i + 1]) / Number(fullResult.hopAmounts[i]);
            const impact = (spotPrice - realizedPrice) / spotPrice;
            if (impact > maxImpact) return { result: null, assessment: null, grossProfitMatic: null };
          }
        }
      }
    }

    const startRate = startRateOverride ?? options.tokenToMaticRates.get(cycle.startToken) ?? 0n;
    if (startRate === 0n) {
      return { result: null, assessment: null, grossProfitMatic: null };
    }

    // Extreme loss/gain check is skipped in minimal search mode (safety net, not correctness)
    if (!minimalForSearch && fullResult) {
      for (let i = 0; i < cycle.edges.length; i++) {
        const edge = cycle.edges[i];
        const rateIn = options.tokenToMaticRates.get(edge.tokenIn) ?? 0n;
        const rateOut = options.tokenToMaticRates.get(edge.tokenOut) ?? 0n;

        if (rateIn > 0n && rateOut > 0n) {
          const valIn = tokensToMaticWei(fullResult.hopAmounts[i], rateIn);
          const valOut = tokensToMaticWei(fullResult.hopAmounts[i + 1], rateOut);

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
      if (outHolder && !outHolder.core) {
        outHolder.core = {} as any;
      }
      const core = computeProfitCore(
        simProfit,
        simAmountIn,
        simGas,
        options.gasPriceWei,
        startRate,
        cycle.edges.length,
        options.flashLoanSource,
        options.slippageBps,
        options.revertRiskBps,
        undefined,
        outHolder?.core,
      );
      netProfitAfterGasMaticWei = core.netProfitAfterGasMaticWei;

      // We still need a minimal assessment object for the "best" tracking logic.
      // This is much smaller pressure than the full object every single iteration.
      if (outHolder && outHolder.assessment) {
        assessment = outHolder.assessment;
        assessment.shouldExecute = netProfitAfterGasMaticWei >= (options.minProfitMaticWei ?? 0n);
        assessment.grossProfit = simProfit;
        assessment.gasCostWei = core.gasCostWei;
        assessment.gasCostInTokens = core.gasCostInTokens;
        assessment.flashLoanFee = core.flashFee;
        assessment.slippageDeduction = core.slippage;
        assessment.revertPenalty = core.revert;
        assessment.netProfit = core.netProfitInTokens;
        assessment.netProfitAfterGas = core.netProfitAfterGasInTokens;
        assessment.netProfitAfterGasMaticWei = netProfitAfterGasMaticWei;
        assessment.roi = core.roi;
      } else {
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
      }
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

    const grossMatic = tokensToMaticWei(simProfit, startRate);

    if (minimalForSearch && outHolder) {
      outHolder.grossProfitMatic = grossMatic;
      outHolder.netProfitAfterGasMaticWei = netProfitAfterGasMaticWei;
      outHolder.assessment = assessment;
      outHolder.result = null;
      return outHolder as any;
    }

    return { result: fullResult, assessment, grossProfitMatic: grossMatic };
  } catch (err) {
    options.logger?.debug?.({ err }, "Single cycle evaluation failed");
    return { result: null, assessment: null, grossProfitMatic: null };
  }
}

export async function evaluatePipeline(
  cycles: FoundCycle[],
  stateCache: RouteStateCache,
  options: PipelineOptions,
  overlay?: PendingStateOverlay,
): Promise<PipelineResult> {
  const profitable: PipelineResult["profitable"] = [];
  let attempted = 0;
  let simulated = 0;
  let pruned = 0;
  let prunedMissingState = 0;
  let prunedInvalidBounds = 0;
  let prunedNoGrossProfit = 0;
  let prunedFinalCheckFailed = 0;
  let noRate = 0;
  let maxGrossMatic: bigint | undefined = undefined;

  const CONCURRENCY = options.concurrency ?? 75;
  const batches: FoundCycle[][] = [];
  for (let i = 0; i < cycles.length; i += CONCURRENCY) {
    batches.push(cycles.slice(i, i + CONCURRENCY));
  }

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    if (profitable.length >= 10) break;

    // Yield to event loop every 2 batches to prevent starvation of
    // mempool signals, WebSocket newHead events, etc.
    if (batchIdx > 0 && batchIdx % 2 === 0) {
      await new Promise((r) => setTimeout(r, 0));
    }

    const results = batch.map((cycle) => {
      attempted++;
      try {
        // ... (the rest of the mapping logic remains)
        // Relaxed gate: only require rate for startToken (the flash principal and profit numeraire).
        // This lets more cycles (with partial rate coverage on intermediates) reach ternary search + assessment
        // while the rate map grows. Missing intermediate rates => 0 contrib to grossMatic (conservative under-estimate)
        // and their extreme loss/gain checks are skipped (see earlier rateIn/rateOut guards).
        const startRate = options.tokenToMaticRates.get(cycle.startToken) ?? 0n;
        if (startRate === 0n) return { type: "noRate" as const, cycle };

        const { low, high } = getDynamicSearchBounds(cycle, stateCache, options.tokenToMaticRates, options.maxFlashLoanUsd ?? 50_000);
        if (low === 0n || low >= high) {
          return { type: "pruned" as const, reason: "invalidBounds", cycle };
        }

        const prebuiltSimEdges = buildSimulationEdges(cycle.edges, stateCache, overlay);
        if (!prebuiltSimEdges) {
          return { type: "pruned" as const, reason: "missingState", cycle };
        }
        let bestResult: RouteSimulationResult | null = null;
        let bestAssessment: ProfitAssessment | null = null;
        let bestProfit = -1_000_000_000_000_000_000_000_000_000_000n;
        let bestGrossMatic = 0n;
        let bestAmount: bigint = low; // track the amount that produced the current best (for final full sim)

        const allV2 = prebuiltSimEdges.every((e) => e.normalizedProtocol === "V2");

        if (allV2) {
          const xStar = solveV2Optimal(prebuiltSimEdges);
          if (xStar <= 0n) {
            return {
              type: "pruned" as const,
              reason: "noGrossProfit",
              cycle,
            };
          }
          bestAmount = xStar > high ? high : xStar < low ? low : xStar;
          const evalOpt = evaluateAmount(cycle, bestAmount, stateCache, options, true, true, prebuiltSimEdges, undefined, overlay, startRate);
          if (evalOpt.grossProfitMatic && evalOpt.grossProfitMatic > 0n && evalOpt.assessment) {
            bestGrossMatic = evalOpt.grossProfitMatic;
            bestResult = evalOpt.result; // null in minimal mode
            bestAssessment = evalOpt.assessment;
            bestProfit = evalOpt.assessment.netProfitAfterGasMaticWei;
          } else {
            return {
              type: "pruned" as const,
              reason: "noGrossProfit",
              cycle,
            };
          }
        } else {
          const maxIters = Math.min(10, options.ternarySearchIterations ?? 8);
          const evalLow = evaluateAmount(cycle, low, stateCache, options, true, true, prebuiltSimEdges, undefined, overlay, startRate);
          if (evalLow.grossProfitMatic === null || evalLow.grossProfitMatic <= 0n) {
            const evalHigh =
              high > low ? evaluateAmount(cycle, high, stateCache, options, true, true, prebuiltSimEdges, undefined, overlay, startRate) : null;
            const highAlsoZero = !evalHigh || evalHigh.grossProfitMatic === null || evalHigh.grossProfitMatic <= 0n;
            if (highAlsoZero) {
              // Low and high are both unprofitable. The optimum may lie in a
              // narrow mid-range (low too small to overcome gas, excessive
              // slippage at high). Probe logarithmically between them.
              const span = high - low;
              const probes = [
                low + span / 10n,   // ~1% of capacity
                low + span / 5n,    // ~2%
                low + span / 3n,    // ~3.3%
                low + span / 2n,    // ~5% (mid)
              ];
              let anyProfitable = false;
              for (const probe of probes) {
                if (probe <= low || probe >= high) continue;
                const evalP = evaluateAmount(cycle, probe, stateCache, options, true, true, prebuiltSimEdges, undefined, overlay, startRate);
                if (evalP.grossProfitMatic && evalP.grossProfitMatic > 0n) {
                  anyProfitable = true;
                  break;
                }
              }
              if (!anyProfitable) {
                return {
                  type: (evalLow.grossProfitMatic === null ? "noRate" : "pruned") as "noRate" | "pruned",
                  reason: "noGrossProfit",
                  cycle,
                };
              }
            }
          }

          const holder: MinimalEvalHolder = {
            grossProfitMatic: null,
            netProfitAfterGasMaticWei: 0n,
            assessment: null,
            result: null,
            core: {} as any,
          };

          const evaluateBrent = (amount: bigint) => {
            const res = evaluateAmount(cycle, amount, stateCache, options, true, true, prebuiltSimEdges, holder, overlay, startRate);
            if (res.grossProfitMatic && res.grossProfitMatic > bestGrossMatic) {
              bestGrossMatic = res.grossProfitMatic;
            }
            if (res.assessment && res.assessment.netProfitAfterGasMaticWei > bestProfit) {
              bestResult = res.result;
              // No clone needed: bestAssessment is only read after the search loop
              // when the final full simulation creates a fresh, unshared assessment object.
              bestProfit = res.assessment.netProfitAfterGasMaticWei;
              bestAmount = amount;
            }
            return res.assessment?.netProfitAfterGasMaticWei ?? -1_000_000_000_000_000_000_000_000_000_000n;
          };

          const brentResult = solveBrentOptimal(low, high, evaluateBrent, maxIters);
          if (brentResult !== bestAmount) {
            // Re-evaluate at the method's best point to ensure consistency
            // (side-effect tracking may differ from Brent's convergence)
            const res = evaluateAmount(cycle, brentResult, stateCache, options, true, true, prebuiltSimEdges, holder, overlay, startRate);
            if (res.assessment && res.assessment.netProfitAfterGasMaticWei > bestProfit) {
              bestProfit = res.assessment.netProfitAfterGasMaticWei;
              bestAmount = brentResult;
            }
          }
        }

        // After search: do one final FULL simulation with impact check enabled.
        // This verifies spot-price integrity before promoting to profitable.
        if (bestAssessment && bestProfit > -1_000_000_000_000_000_000_000_000_000_000n) {
          const final = evaluateAmount(cycle, bestAmount, stateCache, options, false, false, prebuiltSimEdges, undefined, overlay, startRate);
          if (final.result && final.assessment && final.assessment.shouldExecute) {
            bestResult = final.result;
            bestAssessment = final.assessment;
          } else {
            return { type: "pruned" as const, reason: "finalCheckFailed", cycle };
          }
        }

        return { type: "success" as const, bestResult, bestAssessment, bestGrossMatic, cycle };
      } catch (err) {
        if (options.logger) {
          options.logger.error?.(
            {
              err,
              cycleId: cycle.id,
              path: cycle.edges.map((e) => e.poolAddress).join(" -> "),
            },
            "Unexpected error evaluating pipeline cycle",
          );
        }
        return { type: "error" as const, cycle };
      }
    });

    type EvalSuccess = {
      type: "success";
      bestResult: RouteSimulationResult;
      bestAssessment: ProfitAssessment;
      bestGrossMatic: bigint;
      cycle: FoundCycle;
    };
    const sortedResults = results
      .filter((r): r is EvalSuccess => r.type === "success")
      .sort((a, b) => (b.bestGrossMatic > a.bestGrossMatic ? 1 : b.bestGrossMatic < a.bestGrossMatic ? -1 : 0));

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
      else if (res.type === "pruned") {
        pruned++;
        if (res.reason === "missingState") prunedMissingState++;
        else if (res.reason === "invalidBounds") prunedInvalidBounds++;
        else if (res.reason === "noGrossProfit") prunedNoGrossProfit++;
        else if (res.reason === "finalCheckFailed") prunedFinalCheckFailed++;
      } else if (res.type === "success" && "cycle" in res) {
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
    prunedMissingState,
    prunedInvalidBounds,
    prunedNoGrossProfit,
    prunedFinalCheckFailed,
    noRate,
    maxGrossProfitMatic: maxGrossMatic,
  };
}
