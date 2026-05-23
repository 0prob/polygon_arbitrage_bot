import type { FoundCycle } from "./finder.ts";
import type { RouteSimulationResult, RouteStateCache } from "../../core/types/route.ts";
import { simulateRoute, getEffectivePriceImpact } from "./simulator.ts";
import { computeProfit } from "../../core/assessment/profit.ts";
import { FlashLoanSource } from "../../core/types/execution.ts";
import type { ProfitAssessment } from "../../core/types/execution.ts";
import { USDC, USDC_NATIVE, USDT, WBTC } from "../../config/addresses.ts";

const MAX_IMPACT_THRESHOLD = 0.20; // 20%

export interface PipelineOptions {
  minProfitMaticWei: bigint;
  gasPriceWei: bigint;
  tokenToMaticRates: Map<string, bigint>;
  slippageBps?: bigint;
  revertRiskBps?: bigint;
  flashLoanSource?: FlashLoanSource;
}

export function getTestAmount(tokenAddress: string): bigint {
  const addr = tokenAddress.toLowerCase();
  // Target roughly $500 USD for discovery
  if (addr === USDC.toLowerCase() || addr === USDC_NATIVE.toLowerCase() || addr === USDT.toLowerCase()) {
    return 500n * 10n ** 6n; // 500 USDC/USDT
  }
  if (addr === WBTC.toLowerCase()) {
    return 700_000n; // 0.007 BTC (~$500)
  }
  // WETH: 0.16 ETH (~$500)
  if (addr === "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619") {
    return 160_000_000_000_000_000n;
  }
  // WMATIC: 800 MATIC (~$500)
  if (addr === "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270") {
    return 800n * 10n ** 18n;
  }
  // Default to 10 unit of 18-decimal token
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

/** Run the full assessment pipeline: simulate, assess profitability, return only profitable. */
export function evaluatePipeline(cycles: FoundCycle[], stateCache: RouteStateCache, options: PipelineOptions): PipelineResult {
  const profitable: PipelineResult["profitable"] = [];
  let attempted = 0;
  let simulated = 0;
  let pruned = 0;
  let noRate = 0;
  let maxGrossMatic: bigint | undefined = undefined;

  let loggedCount = 0;

  for (const cycle of cycles) {
    attempted++;
    try {
      const rate = options.tokenToMaticRates.get(cycle.startToken.toLowerCase()) ?? 0n;
      
      if (loggedCount < 10) {
        console.log(`[pipeline-diag] Cycle ${attempted}: start=${cycle.startToken}, hops=${cycle.hopCount}, rate=${rate}`);
        for (const edge of cycle.edges) {
          const state = stateCache.get(edge.poolAddress.toLowerCase());
          console.log(`  Edge: pool=${edge.poolAddress}, stateKeys=${state ? Object.keys(state).join(",") : "MISSING"}`);
          if (state) console.log(`  StateData: ${JSON.stringify(state, (k, v) => typeof v === "bigint" ? v.toString() : v)}`);
        }
        loggedCount++;
      }

      if (rate === 0n) {
        noRate++;
        continue;
      }

      // 1. Generate geometric progression of input amounts
      const baseAmount = getTestAmount(cycle.startToken);
      let amt = baseAmount / 5000n;
      if (amt === 0n) amt = 1n; // fallback for tiny decimals
      const amounts: bigint[] = [];
      while (amt <= baseAmount) {
        amounts.push(amt);
        amt = amt * 5n;
      }
      if (amounts[amounts.length - 1] < baseAmount) {
        amounts.push(baseAmount);
      }

      let bestResult: RouteSimulationResult | undefined;
      let bestAssessment: ProfitAssessment | undefined;
      let isPruned = false;
      let worstProfitBps = 0n;

      simulated++; // count cycle as simulated if we enter sweeping
      
      for (let i = 0; i < amounts.length; i++) {
        const testAmt = amounts[i];
        
        // Predictive pruning based on impact for current amount
        let cycleImpactTooHigh = false;
        for (const edge of cycle.edges) {
          const impact = getEffectivePriceImpact(edge, testAmt, stateCache);
          if (impact > MAX_IMPACT_THRESHOLD) {
            cycleImpactTooHigh = true;
            break;
          }
        }

        if (cycleImpactTooHigh) {
          if (i === 0) {
            isPruned = true; // Prune entirely if even the smallest bucket has too high impact
          }
          break; // Stop sweeping, impact only increases with larger amounts
        }

        const result = simulateRoute(cycle.edges, testAmt, stateCache);
        
        // Early exit based on micro-profitability on the smallest bucket
        if (i === 0) {
          const bps = testAmt > 0n ? (result.profit * 10000n) / testAmt : -10000n;
          if (bps < -200n) {
            // Unprofitable even without price impact -> prune early
            worstProfitBps = bps;
            break;
          }
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

        const grossMatic = result.profit * rate;
        if (maxGrossMatic === undefined || grossMatic > maxGrossMatic) {
          maxGrossMatic = grossMatic;
        }

        // We want the highest netProfitAfterGasMaticWei (or netProfitAfterGasInTokens)
        if (!bestAssessment || assessment.netProfitAfterGasMaticWei > bestAssessment.netProfitAfterGasMaticWei) {
          bestResult = result;
          bestAssessment = assessment;
        }
      }

      if (isPruned) {
        pruned++;
        continue;
      }
      
      // If we broke early due to negative profit, bestResult might be undefined
      if (!bestResult || !bestAssessment) {
        continue;
      }

      if (bestAssessment.shouldExecute) {
        profitable.push({ cycle, result: bestResult, assessment: bestAssessment });
      }
    } catch (err) {
      if (attempted % 10000 === 0) {
        console.warn(`[pipeline] Error in cycle ${attempted}:`, err instanceof Error ? err.message : err);
      }
      continue;
    }
  }

  return { 
    profitable, 
    attempted, 
    profitableCount: profitable.length, 
    simulated, 
    pruned, 
    noRate, 
    maxGrossProfitMatic: maxGrossMatic 
  };
}
