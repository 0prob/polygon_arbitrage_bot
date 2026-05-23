import type { FoundCycle } from "./finder.ts";
import type { RouteSimulationResult, RouteStateCache } from "../../core/types/route.ts";
import { simulateRoute, getEffectivePriceImpact } from "./simulator.ts";
import { computeProfit } from "../../core/assessment/profit.ts";
import { FlashLoanSource } from "../../core/types/execution.ts";
import type { ProfitAssessment } from "../../core/types/execution.ts";

const TEST_AMOUNT = 10n ** 18n;
const MAX_IMPACT_THRESHOLD = 0.05; // 5%

export interface PipelineOptions {
  minProfitMaticWei: bigint;
  gasPriceWei: bigint;
  tokenToMaticRate: bigint;
  slippageBps?: bigint;
  revertRiskBps?: bigint;
  flashLoanSource?: FlashLoanSource;
}

export interface PipelineResult {
  profitable: Array<{
    cycle: FoundCycle;
    result: RouteSimulationResult;
    assessment: ProfitAssessment;
  }>;
  attempted: number;
  profitableCount: number;
}

/** Run the full assessment pipeline: simulate, assess profitability, return only profitable. */
export function evaluatePipeline(cycles: FoundCycle[], stateCache: RouteStateCache, options: PipelineOptions): PipelineResult {
  const profitable: PipelineResult["profitable"] = [];
  let attempted = 0;

  for (const cycle of cycles) {
    attempted++;
    try {
      // Predictive pruning based on impact
      for (const edge of cycle.edges) {
        const impact = getEffectivePriceImpact(edge, TEST_AMOUNT, stateCache);
        if (impact > MAX_IMPACT_THRESHOLD) {
          throw new Error("Impact too high");
        }
      }

      const result = simulateRoute(cycle.edges, TEST_AMOUNT, stateCache);
      const assessment = computeProfit({
        grossProfitInTokens: result.profit,
        amountInTokens: result.amountIn,
        gasUnits: result.totalGas,
        gasPriceWei: options.gasPriceWei,
        tokenToMaticRate: options.tokenToMaticRate,
        hopCount: cycle.hopCount,
        minProfitMaticWei: options.minProfitMaticWei,
        slippageBps: options.slippageBps,
        revertRiskBps: options.revertRiskBps,
        flashLoanSource: options.flashLoanSource ?? FlashLoanSource.BALANCER,
      });
      if (assessment.shouldExecute) {
        profitable.push({ cycle, result, assessment });
      }
    } catch {
      continue;
    }
  }

  return { profitable, attempted, profitableCount: profitable.length };
}
