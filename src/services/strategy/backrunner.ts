import type { FoundCycle } from "./finder.ts";
import type { RouteStateCache } from "../../core/types/route.ts";
import { simulateHop } from "./simulator.ts";
import { simulateRoute } from "./simulator.ts";
import { computeProfit } from "../../core/assessment/profit.ts";
import { FlashLoanSource } from "../../core/types/execution.ts";
import type { ProfitAssessment } from "../../core/types/execution.ts";

const TEST_AMOUNT = 10n ** 18n;

export interface LargeSwapSignal {
  txHash: string;
  poolAddress: string;
  tokenIn: string;
  tokenOut: string;
  estimatedSwapSize: bigint;
  protocol?: string;
  zeroForOne?: boolean;
}

export interface BackrunCandidate {
  signal: LargeSwapSignal;
  cycle: FoundCycle;
  result: {
    profit: bigint;
    amountIn: bigint;
    totalGas: number;
  };
  assessment: ProfitAssessment;
}

export interface BackrunnerOptions {
  minProfitMaticWei: bigint;
  gasPriceWei: bigint;
  tokenToMaticRate: bigint;
  maxHops: number;
}

/**
 * Backrunner evaluates whether a large pending swap creates an arbitrage opportunity.
 *
 * Strategy:
 * 1. Given a large swap on a pool, the post-swap reserves will be imbalanced
 * 2. This creates an opportunity to trade back through the same pool or via other pools
 * 3. We search for 2-hop cycles (A->B->A) involving the affected pool
 */
export class Backrunner {
  constructor(private options: BackrunnerOptions) {}

  evaluate(
    signal: LargeSwapSignal,
    stateCache: RouteStateCache,
    enumerateCyclesFn: (startToken: string, maxHops: number) => FoundCycle[],
  ): BackrunCandidate | null {
    const poolAddr = signal.poolAddress.toLowerCase();
    const state = stateCache.get(poolAddr);
    if (!state) return null;

    const stateRecord = state as Record<string, unknown>;
    const zeroForOne =
      signal.zeroForOne ??
      (() => {
        const t0 = stateRecord.token0 as string | undefined;
        if (t0 && signal.tokenIn) return signal.tokenIn.toLowerCase() === t0.toLowerCase();
        return true;
      })();

    const simulatedSwap = simulateHop(
      {
        poolAddress: signal.poolAddress,
        tokenIn: signal.tokenIn,
        tokenOut: signal.tokenOut,
        protocol: signal.protocol ?? "UNISWAP_V2",
        zeroForOne,
        stateRef: state,
      },
      signal.estimatedSwapSize,
      stateCache,
    );
    if (!simulatedSwap) return null;

    const candidateTokens = [
      signal.tokenIn,
      signal.tokenOut,
      stateRecord.token0 as string | undefined,
      stateRecord.token1 as string | undefined,
    ].filter(Boolean) as string[];
    const uniqueStarts = [...new Set(candidateTokens.map((t) => t.toLowerCase()))];
    const allRelevantEdges: FoundCycle[] = [];
    for (const tok of uniqueStarts) {
      for (const c of enumerateCyclesFn(tok, this.options.maxHops)) {
        if (!allRelevantEdges.some((x) => x.startToken === c.startToken && x.edges.length === c.edges.length)) {
          allRelevantEdges.push(c);
        }
      }
    }

    const neededAddrs = new Set<string>();
    for (const c of allRelevantEdges) {
      for (const e of c.edges) {
        neededAddrs.add(e.poolAddress.toLowerCase());
        neededAddrs.add(e.tokenIn.toLowerCase());
        neededAddrs.add(e.tokenOut.toLowerCase());
      }
    }
    neededAddrs.add(poolAddr);
    const tempCache: RouteStateCache = new Map();
    for (const addr of neededAddrs) {
      const s = stateCache.get(addr);
      if (s) tempCache.set(addr, s);
    }
    const reserve0 = stateRecord.reserve0 as bigint | undefined;
    const reserve1 = stateRecord.reserve1 as bigint | undefined;
    if (reserve0 !== undefined && reserve1 !== undefined) {
      tempCache.set(poolAddr, {
        ...state,
        reserve0: zeroForOne ? reserve0 + signal.estimatedSwapSize : reserve0 - simulatedSwap.amountOut,
        reserve1: zeroForOne ? reserve1 - simulatedSwap.amountOut : reserve1 + signal.estimatedSwapSize,
      });
    }

    const relevantCycles = allRelevantEdges.filter((c) => c.edges.some((e) => e.poolAddress.toLowerCase() === poolAddr));

    for (const cycle of relevantCycles) {
      try {
        const result = simulateRoute(cycle.edges, TEST_AMOUNT, tempCache);
        const assessment = computeProfit({
          grossProfitInTokens: result.profit,
          amountInTokens: result.amountIn,
          gasUnits: result.totalGas,
          gasPriceWei: this.options.gasPriceWei,
          tokenToMaticRate: this.options.tokenToMaticRate,
          hopCount: cycle.hopCount,
          minProfitMaticWei: this.options.minProfitMaticWei,
          flashLoanSource: FlashLoanSource.BALANCER,
        });
        if (assessment.shouldExecute) {
          return {
            signal,
            cycle,
            result: { profit: result.profit, amountIn: result.amountIn, totalGas: result.totalGas },
            assessment,
          };
        }
      } catch {
        continue;
      }
    }

    return null;
  }
}
