import type { RouteSimulationResult, RouteStateCache } from "../../core/types/route.ts";
import type { PoolState } from "../../core/types/pool.ts";
import type { CandidateExecution, ExecutionResult } from "../execution/service.ts";

export interface SimulationTrace {
  timestamp: number;
  routeKey: string;
  expectedAmountIn: string;
  expectedAmountOut: string;
  expectedProfit: string;
  states: Record<string, PoolState>;
  hops: Array<{
    protocol: string;
    pool: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: string;
    amountOut: string;
  }>;
}

export interface ExecutionComparison {
  routeKey: string;
  txHash: string;
  simulatedProfit: string;
  actualProfit: string;
  profitLeak: string; // simulated - actual
  gasUsed: string;
  gasCostMatic: string;
  wasProfitable: boolean;
}

/**
 * Instrumentation helper to capture and analyze arbitrage performance data.
 * This is designed to help debug "phantom profits" and tune the engine.
 */
export class ArbInstrumenter {
  private traces = new Map<string, SimulationTrace>();

  /** Capture the exact state used during simulation */
  captureTrace(
    routeKey: string,
    result: RouteSimulationResult,
    stateCache: RouteStateCache
  ): void {
    const states: Record<string, PoolState> = {};
    for (const pool of result.poolPath) {
      const s = stateCache.get(pool.toLowerCase());
      if (s) states[pool.toLowerCase()] = { ...s as any };
    }

    const hops = result.protocols.map((protocol, i) => ({
      protocol,
      pool: result.poolPath[i],
      tokenIn: result.tokenPath[i],
      tokenOut: result.tokenPath[i + 1],
      amountIn: result.hopAmounts[i].toString(),
      amountOut: result.hopAmounts[i + 1].toString(),
    }));

    this.traces.set(routeKey, {
      timestamp: Date.now(),
      routeKey,
      expectedAmountIn: result.amountIn.toString(),
      expectedAmountOut: result.amountOut.toString(),
      expectedProfit: result.profit.toString(),
      states,
      hops,
    });

    // Keep memory in check
    if (this.traces.size > 100) {
      const oldest = Array.from(this.traces.keys())[0];
      this.traces.delete(oldest);
    }
  }

  /** Compare simulation vs. reality after an execution attempt */
  compareExecution(
    candidate: CandidateExecution,
    result: ExecutionResult,
    actualProfit: bigint,
    gasCostMatic: bigint
  ): ExecutionComparison | null {
    const trace = this.traces.get(candidate.routeKey);
    if (!trace) return null;

    const simProfit = BigInt(trace.expectedProfit);
    const leak = simProfit - actualProfit;

    return {
      routeKey: candidate.routeKey,
      txHash: result.txHash || "N/A",
      simulatedProfit: simProfit.toString(),
      actualProfit: actualProfit.toString(),
      profitLeak: leak.toString(),
      gasUsed: result.gasUsed?.toString() || "0",
      gasCostMatic: gasCostMatic.toString(),
      wasProfitable: actualProfit > gasCostMatic,
    };
  }

  getTrace(routeKey: string): SimulationTrace | undefined {
    return this.traces.get(routeKey);
  }
}
