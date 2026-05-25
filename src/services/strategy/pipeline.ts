import type { FoundCycle } from "./finder.ts";
import type { RouteSimulationResult, RouteStateCache } from "../../core/types/route.ts";
import { simulateRoute, getEffectivePriceImpact } from "./simulator.ts";
import { computeProfit } from "../../core/assessment/profit.ts";
import { FlashLoanSource } from "../../core/types/execution.ts";
import type { ProfitAssessment } from "../../core/types/execution.ts";
import { USDC, USDC_NATIVE, USDT, WBTC } from "../../config/addresses.ts";

const CONVERGENCE_DIVISOR = 10000n;

export interface PipelineOptions {
  minProfitMaticWei: bigint;
  gasPriceWei: bigint;
  tokenToMaticRates: Map<string, bigint>;
  slippageBps?: bigint;
  revertRiskBps?: bigint;
  flashLoanSource?: FlashLoanSource;
  ternarySearchIterations?: number;
  maxPriceImpactThreshold?: number;
  onProgress?: (current: number, total: number, profitable: number) => void;
}

export function getTestAmount(tokenAddress: string): bigint {
  const addr = tokenAddress.toLowerCase();
  if (addr === USDC.toLowerCase() || addr === USDC_NATIVE.toLowerCase() || addr === USDT.toLowerCase()) {
    return 500n * 10n ** 6n;
  }
  if (addr === WBTC.toLowerCase()) {
    return 700_000n;
  }
  if (addr === "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619") {
    return 160_000_000_000_000_000n;
  }
  if (addr === "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270") {
    return 800n * 10n ** 18n;
  }
  return 10n * 10n ** 18n;
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

function getEffectivePriceImpactForCycle(cycle: FoundCycle, amount: bigint, stateCache: RouteStateCache, maxImpactThreshold: number = 0.15): boolean {
  for (const edge of cycle.edges) {
    const impact = getEffectivePriceImpact(edge, amount, stateCache);
    if (impact > maxImpactThreshold) return true;
  }
  return false;
}

function evaluateAmount(
  cycle: FoundCycle,
  amount: bigint,
  stateCache: RouteStateCache,
  options: PipelineOptions,
): { result: RouteSimulationResult | null; assessment: ProfitAssessment | null; grossProfitMatic: bigint | null } {
  const maxImpact = options.maxPriceImpactThreshold ?? 0.15;
  if (getEffectivePriceImpactForCycle(cycle, amount, stateCache, maxImpact)) {
    return { result: null, assessment: null, grossProfitMatic: null };
  }

  try {
    const result = simulateRoute(cycle.edges, amount, stateCache);
    const rate = options.tokenToMaticRates.get(cycle.startToken.toLowerCase()) ?? 0n;
    if (rate === 0n) {
      return { result: null, assessment: null, grossProfitMatic: null };
    }

    const assessment = computeProfit({
      grossProfitInTokens: result.profit,
      amountInTokens: result.amountIn,
      gasUnits: result.totalGas,
      gasPriceWei: options.gasPriceWei,
      tokenToMaticRate: rate,
      hopCount: cycle.hopCount,
      minProfitMaticWei: options.minProfitMaticWei,
      slippageBps: options.slippageBps,
      revertRiskBps: options.revertRiskBps,
      flashLoanSource: options.flashLoanSource ?? FlashLoanSource.BALANCER,
    });

    const grossMatic = (result.profit * rate) / 1000000000000000000n;
    return { result, assessment, grossProfitMatic: grossMatic };
  } catch {
    return { result: null, assessment: null, grossProfitMatic: null };
  }
}

export async function evaluatePipeline(cycles: FoundCycle[], stateCache: RouteStateCache, options: PipelineOptions): Promise<PipelineResult> {
  const profitable: PipelineResult["profitable"] = [];
  let attempted = 0;
  let simulated = 0;
  let pruned = 0;
  let noRate = 0;
  let maxGrossMatic: bigint | undefined = undefined;

  for (const cycle of cycles) {
    attempted++;

    // Yield to event loop to keep TUI responsive and prevent blocking
    if (attempted % 100 === 0) {
      if (options.onProgress) {
        options.onProgress(attempted, cycles.length, profitable.length);
      }
      await new Promise(resolve => setImmediate(resolve));
    }

    try {
      const rate = options.tokenToMaticRates.get(cycle.startToken.toLowerCase()) ?? 0n;

      if (rate === 0n) {
        noRate++;
        continue;
      }

      const baseAmount = getTestAmount(cycle.startToken);
      const low = baseAmount / 5000n;
      if (low === 0n) continue;
      const high = baseAmount;
      const ternaryIters = options.ternarySearchIterations ?? 15;
      const maxImpact = options.maxPriceImpactThreshold ?? 0.15;

      // Check if even the smallest amount has too much impact
      if (getEffectivePriceImpactForCycle(cycle, low, stateCache, maxImpact)) {
        pruned++;
        continue;
      }

      // Ternary search for optimal input amount
      let left = low;
      let right = high;
      let bestResult: RouteSimulationResult | null = null;
      let bestAssessment: ProfitAssessment | null = null;
      let bestProfit = -1n;
      let bestGrossMatic = 0n;
      simulated++;

      for (let iter = 0; iter < ternaryIters; iter++) {
        const range = right - left;
        if (range <= baseAmount / CONVERGENCE_DIVISOR) {
          // Binary search refinement for precision
          const mid = left + range / 2n;
          const { result, assessment, grossProfitMatic } = evaluateAmount(cycle, mid, stateCache, options);
          if (result && assessment && assessment.netProfitAfterGas > bestProfit) {
            bestResult = result;
            bestAssessment = assessment;
            bestProfit = assessment.netProfitAfterGas;
            bestGrossMatic = grossProfitMatic ?? 0n;
          }
          break;
        }

        const m1 = left + range / 3n;
        const m2 = right - range / 3n;

        const eval1 = evaluateAmount(cycle, m1, stateCache, options);
        const eval2 = evaluateAmount(cycle, m2, stateCache, options);

        const profit1 = (eval1.assessment?.netProfitAfterGas ?? -1n);
        const profit2 = (eval2.assessment?.netProfitAfterGas ?? -1n);

        if (profit1 > bestProfit && eval1.result && eval1.assessment) {
          bestResult = eval1.result;
          bestAssessment = eval1.assessment;
          bestProfit = profit1;
          bestGrossMatic = eval1.grossProfitMatic ?? 0n;
        }
        if (profit2 > bestProfit && eval2.result && eval2.assessment) {
          bestResult = eval2.result;
          bestAssessment = eval2.assessment;
          bestProfit = profit2;
          bestGrossMatic = eval2.grossProfitMatic ?? 0n;
        }

        if (profit1 < 0 && profit2 < 0) {
          // Both too high impact — search toward smaller amounts
          if (eval1.result === null && eval2.result === null) {
            // Both exceeded impact threshold, narrow left
            right = m1;
          } else {
            // At least one returned a result, narrow toward better one
            if (profit1 > profit2) {
              right = m2;
            } else {
              left = m1;
            }
          }
        } else if (profit1 > profit2) {
          right = m2;
        } else {
          left = m1;
        }
      }

      if (bestGrossMatic > 0n && (maxGrossMatic === undefined || bestGrossMatic > maxGrossMatic)) {
        maxGrossMatic = bestGrossMatic;
      }

      if (!bestResult || !bestAssessment) continue;

      if (bestAssessment.shouldExecute) {
        profitable.push({ cycle, result: bestResult, assessment: bestAssessment });
      }
    } catch (err) {
      // Ignore individual cycle simulation errors to keep pipeline moving
    }
  }

  // Final progress update
  if (options.onProgress) {
    options.onProgress(attempted, cycles.length, profitable.length);
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
