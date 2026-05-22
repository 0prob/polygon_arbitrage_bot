import { buildArbTx, type BuilderRouteInput, type BuilderConfig } from "./builder.ts";
import type { CandidateExecution } from "./service.ts";
import type { PipelineResult } from "../strategy/pipeline.ts";

export type ProfitableResult = PipelineResult["profitable"][number];

export interface CandidateBuilderOptions {
  slippageBps: number;
}

export function buildExecutionCandidate(
  profitable: ProfitableResult,
  config: BuilderConfig,
  options: CandidateBuilderOptions,
): CandidateExecution {
  const edges = profitable.cycle.edges.map((e) => {
    const fee = Number(e.feeBps ?? 0);
    return {
      poolAddress: e.poolAddress,
      tokenIn: e.tokenIn,
      tokenOut: e.tokenOut,
      protocol: e.protocol,
      zeroForOne: (e as any).zeroForOne ?? e.tokenIn < e.tokenOut,
      fee,
      swapFeeBps: fee,
      metadata: {},
      tokenInIdx: 0,
      tokenOutIdx: 1,
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

  const built = buildArbTx(route, config, { slippageBps: options.slippageBps });

  return {
    routeKey: built.routeHash,
    calldata: built.data,
    targetAddress: built.to,
    value: built.value,
  };
}
