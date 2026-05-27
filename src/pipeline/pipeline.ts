import type { FoundCycle } from "./types.ts";
import type { RouteSimulationResult, RouteStateCache } from "../core/types/route.ts";
import { simulateRoute, simulateHop, getEffectivePriceImpact, getTestAmount } from "./simulator.ts";
import type { SimulationEdge } from "./types.ts";
import { computeProfit } from "../core/assessment/profit.ts";
import { FlashLoanSource } from "../core/types/execution.ts";
import type { ProfitAssessment } from "../core/types/execution.ts";
import type { PoolState } from "../core/types/pool.ts";

const CONVERGENCE_DIVISOR = 10000n;

export interface PipelineOptions {
  minProfitMaticWei: bigint;
  gasPriceWei: bigint;
  tokenToMaticRates: Map<string, bigint>;
  tokenMetas?: Map<string, { decimals: number }>;
  slippageBps?: bigint;
  revertRiskBps?: bigint;
  flashLoanSource?: FlashLoanSource;
  ternarySearchIterations?: number;
  maxPriceImpactThreshold?: number;
  concurrency?: number;
  roiSafetyCap?: number;
  logger?: any;
  onProgress?: (current: number, total: number, profitable: number) => void;
}

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
    } catch {
      return true;
    }
  }
  return false;
}

function evaluateAmount(
  cycle: FoundCycle,
  amount: bigint,
  stateCache: RouteStateCache,
  options: PipelineOptions,
  skipImpactCheck: boolean = false
): { result: RouteSimulationResult | null; assessment: ProfitAssessment | null; grossProfitMatic: bigint | null } {
  if (!skipImpactCheck) {
    const maxImpact = options.maxPriceImpactThreshold ?? 0.15;
    if (getEffectivePriceImpactForCycle(cycle, amount, stateCache, maxImpact)) {
      return { result: null, assessment: null, grossProfitMatic: null };
    }
  }

  try {
    const result = simulateRoute(cycle.edges, amount, stateCache);
    const startRate = options.tokenToMaticRates.get(cycle.startToken.toLowerCase()) ?? 0n;
    if (startRate === 0n) {
      return { result: null, assessment: null, grossProfitMatic: null };
    }

    for (let i = 0; i < cycle.edges.length; i++) {
      const edge = cycle.edges[i];
      const rateIn = options.tokenToMaticRates.get(edge.tokenIn.toLowerCase()) ?? 0n;
      const rateOut = options.tokenToMaticRates.get(edge.tokenOut.toLowerCase()) ?? 0n;
      
      if (rateIn > 0n && rateOut > 0n) {
        const valIn = (result.hopAmounts[i] * rateIn) / 10n**18n;
        const valOut = (result.hopAmounts[i+1] * rateOut) / 10n**18n;
        
        const isExtremeLoss = valOut < valIn / 2n;
        const isExtremeGain = valOut > valIn * 5n;

        if ((isExtremeLoss || isExtremeGain) && valIn > 10n**15n) { 
           return { result: null, assessment: null, grossProfitMatic: null };
        }
      }
    }

    const assessment = computeProfit({
      grossProfitInTokens: result.profit,
      amountInTokens: result.amountIn,
      gasUnits: result.totalGas,
      gasPriceWei: options.gasPriceWei,
      tokenToMaticRate: startRate,
      hopCount: cycle.edges.length,
      minProfitMaticWei: options.minProfitMaticWei ?? 0n,
      flashLoanSource: options.flashLoanSource,
    });

    const grossMatic = (result.profit * startRate) / 10n ** 18n;
    return { result, assessment, grossProfitMatic: grossMatic };
  } catch {
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
          const tokens = [cycle.startToken, ...cycle.edges.map(e => e.tokenOut)];
          const hasAllRates = tokens.every(t => (options.tokenToMaticRates.get(t.toLowerCase()) ?? 0n) > 0n);
          if (!hasAllRates) return { type: "noRate" as const };

          const startRate = options.tokenToMaticRates.get(cycle.startToken.toLowerCase())!;
          const baseAmount = getTestAmount(cycle.startToken, options.tokenMetas);
          const low = baseAmount / 5000n;
          if (low === 0n) return { type: "pruned" as const };
          const high = baseAmount;
          const ternaryIters = options.ternarySearchIterations ?? 15;
          const maxImpact = options.maxPriceImpactThreshold ?? 0.15;

          const evalLow = evaluateAmount(cycle, low, stateCache, options);
          if (!evalLow.result || evalLow.grossProfitMatic === null || evalLow.grossProfitMatic <= 0n) {
            return { type: (evalLow.grossProfitMatic === null ? "noRate" : "pruned") as const };
          }

          let left = low;
          let right = high;
          let bestResult: RouteSimulationResult | null = null;
          let bestAssessment: ProfitAssessment | null = null;
          let bestProfit = -1_000_000_000_000_000_000_000_000_000_000n;
          let bestGrossMatic = 0n;

          for (let iter = 0; iter < ternaryIters; iter++) {
            const range = right - left;
            if (range <= baseAmount / CONVERGENCE_DIVISOR) {
              const mid = left + range / 2n;
              const { result, assessment, grossProfitMatic } = evaluateAmount(cycle, mid, stateCache, options);
              
              if (grossProfitMatic && grossProfitMatic > bestGrossMatic) {
                bestGrossMatic = grossProfitMatic;
              }

              if (result && assessment && assessment.netProfitAfterGasMaticWei > bestProfit) {
                bestResult = result;
                bestAssessment = assessment;
                bestProfit = assessment.netProfitAfterGasMaticWei;
              }
              break;
            }

            const m1 = left + range / 3n;
            const m2 = right - range / 3n;
            const eval1 = evaluateAmount(cycle, m1, stateCache, options);
            const eval2 = evaluateAmount(cycle, m2, stateCache, options);

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
            }
            if (profit2 > bestProfit && eval2.result && eval2.assessment) {
              bestResult = eval2.result;
              bestAssessment = eval2.assessment;
              bestProfit = profit2;
            }

            if (profit1 < 0 && profit2 < 0) {
              if (eval1.result === null && eval2.result === null) {
                right = m1;
              } else {
                if (profit1 > profit2) right = m2; else left = m1;
              }
            } else if (profit1 > profit2) {
              right = m2;
            } else {
              left = m1;
            }
          }

          return { type: "success" as const, bestResult, bestAssessment, bestGrossMatic };
        } catch {
          return { type: "error" as const };
        }
      })
    );

    const sortedResults = results
      .filter((r) => r.type === "success")
      .sort((a: any, b: any) => Number(b.bestGrossMatic - a.bestGrossMatic));

    if (sortedResults.length > 0 && (sortedResults[0] as any).bestGrossMatic > 0n) {
      const top = sortedResults[0] as any;
      if (top.bestAssessment && top.bestResult) {
        if (top.bestGrossMatic > 10n * 10n ** 18n) {
          const path = top.bestResult.poolPath.join(" -> ");
          const roi = top.bestAssessment.roi / 1_000_000;
          if (options.logger) {
            options.logger.debug({ 
              grossMatic: (top.bestGrossMatic / 10n**15n).toString() + "mMATIC",
              roi,
              path,
              reason: top.bestAssessment.rejectReason 
            }, "Top outlier detected in pass");
          }
        }
      }
    }

    for (const res of results) {
      if (res.type === "noRate") noRate++;
      else if (res.type === "pruned") pruned++;
      else if (res.type === "success") {
        simulated++;
        if (res.bestGrossMatic > 0n && (maxGrossMatic === undefined || res.bestGrossMatic > maxGrossMatic)) {
          maxGrossMatic = res.bestGrossMatic;
        }
        if (res.bestResult && res.bestAssessment && res.bestAssessment.shouldExecute) {
          if (options.logger) {
            options.logger.info({
              routeKey: batch[results.indexOf(res)].id,
              profit: res.bestAssessment.netProfitAfterGasMaticWei.toString(),
              roi: res.bestAssessment.roi / 1_000_000,
              path: res.bestResult.poolPath.join(" -> ")
            }, "Evaluating profitable candidate");
          }
          profitable.push({ cycle: batch[results.indexOf(res)], result: res.bestResult, assessment: res.bestAssessment });
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
