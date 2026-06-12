import type { RuntimeContext } from "../../orchestrator/boot.ts";
import type { LargeSwapSignal } from "../mempool/signals.ts";
import type { CandidateExecution } from "../execution/service.ts";
import { submitFastLaneBundleHttp, buildFastLaneBundle, type SolverOperationPayload } from "./fastlane_relay.ts";

export interface BackrunContext {
  victim: LargeSwapSignal;
  candidate: CandidateExecution;
  operatorAddress: string;
}

/** Build a minimal solver op placeholder — production requires Atlas SolverBase contract + EIP-712 signing. */
export function buildPlaceholderSolverOp(ctx: BackrunContext): SolverOperationPayload {
  return {
    from: ctx.operatorAddress,
    to: ctx.candidate.targetAddress,
    value: "0x0",
    gas: ctx.candidate.gasLimit?.toString() ?? "500000",
    maxFeePerGas: "0x0",
    maxPriorityFeePerGas: "0x0",
    nonce: "0x0",
    deadline: 0,
    userOpHash: ctx.victim.txHash,
    dAppControl: "0x0000000000000000000000000000000000000000",
    dAppSigner: ctx.operatorAddress,
    bidToken: "0x0000000000000000000000000000000000000000",
    bidAmount: "0x0",
    data: ctx.candidate.calldata,
    signature: "0x",
  };
}

export async function submitBackrunBundle(
  ctx: RuntimeContext,
  backrun: BackrunContext,
  victimRawTx: string,
): Promise<{ submitted: boolean; mode: "fastlane" | "public_fallback" | "skipped"; detail?: string }> {
  if (!ctx.config.mev.enabled) {
    return { submitted: false, mode: "skipped", detail: "mev disabled" };
  }

  const solverOp = buildPlaceholderSolverOp(backrun);
  const bundle = buildFastLaneBundle(victimRawTx, solverOp);
  const relay = await submitFastLaneBundleHttp(ctx.config.mev.fastlaneRelayUrl, bundle);
  if (relay.ok) {
    return { submitted: true, mode: "fastlane", detail: relay.result };
  }

  if (ctx.config.mev.publicBackrunFallback) {
    return { submitted: false, mode: "public_fallback", detail: relay.error };
  }

  return { submitted: false, mode: "skipped", detail: relay.error };
}
