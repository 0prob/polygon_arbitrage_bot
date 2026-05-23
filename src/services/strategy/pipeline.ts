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

export function getMicroAmount(tokenAddress: string): bigint {
  const addr = tokenAddress.toLowerCase();
  // Target roughly $10 USD for micro-simulation
  if (addr === USDC.toLowerCase() || addr === USDC_NATIVE.toLowerCase() || addr === USDT.toLowerCase()) {
    return 10n * 10n ** 6n;
  }
  if (addr === WBTC.toLowerCase()) {
    return 15_000n; // ~ $10
  }
  return 10n ** 18n / 10n; // 0.1 unit of 18-decimal token
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

      // 1. Micro-simulation to find high-margin discrepancies
      const microAmount = getMicroAmount(cycle.startToken);
      const microResult = simulateRoute(cycle.edges, microAmount, stateCache);
      
      const microProfitBps = microAmount > 0n ? (microResult.profit * 10000n) / microAmount : -10000n;
      
      if (loggedCount <= 10) {
        console.log(`  Micro: in=${microAmount}, out=${microResult.amountOut}, profit=${microResult.profit}, bps=${microProfitBps}`);
      }
      
      // If loss is > 2% (200 bps), it's definitely a junk cycle
      if (microProfitBps < -200n) {
        continue;
      }

      // 2. Real simulation for cycles that are close to breakeven or better
      const testAmount = getTestAmount(cycle.startToken);
      
      // Predictive pruning based on impact for real amount
      let isPruned = false;
      for (const edge of cycle.edges) {
        const impact = getEffectivePriceImpact(edge, testAmount, stateCache);
        if (impact > MAX_IMPACT_THRESHOLD) {
          isPruned = true;
          break;
        }
      }
      if (isPruned) {
        pruned++;
        continue;
      }

      simulated++;
      const result = simulateRoute(cycle.edges, testAmount, stateCache);
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

      if (assessment.shouldExecute) {
        profitable.push({ cycle, result, assessment });
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
