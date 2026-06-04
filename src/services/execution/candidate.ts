import { buildArbTx, type BuilderRouteInput, type BuilderConfig } from "./builder.ts";
import type { CandidateExecution } from "./service.ts";
import type { PipelineResult } from "../../pipeline/index.ts";
import { routeKeyFromEdges } from "../../pipeline/index.ts";
import type { RouteStateCache } from "../../core/types/route.ts";

export type ProfitableResult = PipelineResult["profitable"][number];

export interface CandidateBuilderOptions {
  slippageBps: number;
  /**
   * Flash loan source — required. The bot executes 100% of arbs via flash loans (Balancer/Aave).
   * This value flows from config -> orchestrator -> candidate builder -> calldata.
   * amountIn = exact flash borrow size for the entire route.
   */
  flashLoanSource: "BALANCER" | "AAVE_V3";
  stateCache?: RouteStateCache;
}

export function buildExecutionCandidate(
  profitable: ProfitableResult,
  config: BuilderConfig,
  options: CandidateBuilderOptions,
): CandidateExecution {
  const edges = profitable.cycle.edges.map((e) => {
    const fee = Number(e.feeBps ?? 0);
    const addr = e.poolAddress.toLowerCase();
    const state = options.stateCache?.get(addr);

    return {
      poolAddress: e.poolAddress,
      tokenIn: e.tokenIn,
      tokenOut: e.tokenOut,
      protocol: e.protocol,
      zeroForOne: e.zeroForOne,
      fee,
      swapFeeBps: fee,
      metadata: {},
      tokenInIdx: e.tokenInIdx,
      tokenOutIdx: e.tokenOutIdx,
      stateRef: (state ?? e.stateRef ?? undefined) as Record<string, unknown> | undefined,
    };
  });

  const route: BuilderRouteInput = {
    path: { startToken: profitable.cycle.startToken, edges },
    result: {
      amountIn: profitable.result.amountIn,
      amountOut: profitable.result.amountOut,
      hopAmounts: profitable.result.hopAmounts,
      tokenPath: profitable.result.tokenPath,
      poolPath: profitable.result.poolPath,
      profit: profitable.assessment.netProfitAfterGas,
    },
  };

  // minProfit is enforced on-chain against the profit denominated in profitToken (start-token units).
  // We must NOT use netProfitAfterGasMaticWei here — that's MATIC wei and would be wrong for
  // any token other than WMATIC. Use token-unit profit at 90% as the on-chain minimum guard.
  const tokenProfit = profitable.assessment.netProfitAfterGas;
  const minProfit = tokenProfit > 0n ? (tokenProfit * 90n) / 100n : 0n;
  const built = buildArbTx(route, config, { slippageBps: options.slippageBps, minProfit, flashLoanSource: options.flashLoanSource });

  // Use cycle-derived identity key (not the calldata hash) for quarantine/inflight/tracker/poolsFromRouteKey.
  // The hash is an internal on-chain guard; bot state keys on the route identity for consistency with
  // pre-filters, cooldowns, and pool-disjoint batching.
  const identityKey = profitable.cycle.id ?? routeKeyFromEdges(profitable.cycle.edges, profitable.cycle.startToken);

  return {
    routeKey: identityKey,
    calldata: built.data,
    targetAddress: built.to,
    value: built.value,
    profitToken: profitable.cycle.startToken,
    expectedProfit: profitable.assessment.netProfitAfterGas,
  };
}
