import type { RuntimeContext } from "../../orchestrator/boot.ts";
import type { LargeSwapSignal } from "../mempool/signals.ts";
import type { CandidateExecution } from "../execution/service.ts";
import { submitFastLaneBundleHttp, buildFastLaneBundle, type SolverOperationPayload } from "./fastlane_relay.ts";
import type { PublicClient, Hash, Hex } from "viem";
import { getAddress } from "viem";

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

function matchesBackrunTx(
  tx: { from?: string; to?: string | null; input?: Hex },
  operatorAddress: string,
  candidate: CandidateExecution,
): boolean {
  const operator = getAddress(operatorAddress).toLowerCase();
  const target = getAddress(candidate.targetAddress).toLowerCase();
  return (
    tx.from?.toLowerCase() === operator &&
    tx.to?.toLowerCase() === target &&
    tx.input?.toLowerCase() === candidate.calldata.toLowerCase()
  );
}

/** Scan the victim block for our bundled backrun tx once the victim lands. */
export function findBackrunTxInBlock(
  blockTransactions: Array<Hash | { from?: string; to?: string | null; input?: Hex; hash?: Hash }>,
  operatorAddress: string,
  candidate: CandidateExecution,
): Hash | null {
  for (const tx of blockTransactions) {
    if (typeof tx === "string") continue;
    if (matchesBackrunTx(tx, operatorAddress, candidate) && tx.hash) {
      return tx.hash;
    }
  }
  return null;
}

/**
 * Wait for a FastLane bundle to land by watching the victim tx, then scanning its block
 * for a matching operator→executor call. Returns null if the bundle never lands.
 */
export async function waitForBundledBackrunTx(
  client: PublicClient,
  backrun: BackrunContext,
  victimTxHash: string,
  timeoutMs: number,
  pollMs = 250,
): Promise<{ txHash: Hash } | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const victimReceipt = await client.getTransactionReceipt({ hash: victimTxHash as Hash });
      const block = await client.getBlock({
        blockNumber: victimReceipt.blockNumber,
        includeTransactions: true,
      });
      const backrunHash = findBackrunTxInBlock(block.transactions, backrun.operatorAddress, backrun.candidate);
      if (backrunHash) return { txHash: backrunHash };
      return null;
    } catch (err: unknown) {
      const error = err as { name?: string; message?: string };
      const msg = error.message?.toLowerCase() ?? "";
      const notFound =
        error.name === "TransactionReceiptNotFoundError" ||
        msg.includes("not found") ||
        msg.includes("could not be found");
      if (!notFound) throw err;
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }

  return null;
}
