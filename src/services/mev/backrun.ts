import type { RuntimeContext } from "../../orchestrator/boot.ts";
import type { LargeSwapSignal } from "../mempool/signals.ts";
import type { CandidateExecution } from "../execution/service.ts";
import { submitFastLaneBundleHttp, buildFastLaneBundle, type SolverOperationPayload } from "./fastlane_relay.ts";
import type { Hash, Hex } from "viem";
import { getAddress } from "viem";

export interface BackrunContext {
  victim: LargeSwapSignal;
  candidate: CandidateExecution;
  operatorAddress: string;
}

export interface BackrunTxFees {
  nonce: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export type BackrunRpcContext = Pick<RuntimeContext, "publicClient" | "hyperRpc">;

function toHexQuantity(value: bigint): string {
  return `0x${value.toString(16)}`;
}

/** Build a minimal solver op placeholder — production requires Atlas SolverBase contract + EIP-712 signing. */
export function buildPlaceholderSolverOp(ctx: BackrunContext, fees: BackrunTxFees): SolverOperationPayload {
  return {
    from: ctx.operatorAddress,
    to: ctx.candidate.targetAddress,
    value: "0x0",
    gas: ctx.candidate.gasLimit?.toString() ?? "500000",
    maxFeePerGas: toHexQuantity(fees.maxFeePerGas),
    maxPriorityFeePerGas: toHexQuantity(fees.maxPriorityFeePerGas),
    nonce: toHexQuantity(BigInt(fees.nonce)),
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
  fees: BackrunTxFees,
): Promise<{ submitted: boolean; mode: "fastlane" | "public_fallback" | "skipped"; detail?: string }> {
  if (!ctx.config.mev.enabled) {
    return { submitted: false, mode: "skipped", detail: "mev disabled" };
  }

  const solverOp = buildPlaceholderSolverOp(backrun, fees);
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

async function fetchVictimReceiptBlockNumber(
  rpc: BackrunRpcContext,
  victimTxHash: string,
): Promise<bigint | null> {
  if (rpc.hyperRpc) {
    try {
      const receipt = await rpc.hyperRpc.getTransactionReceipt(victimTxHash as `0x${string}`);
      if (receipt?.blockNumber) return BigInt(receipt.blockNumber);
    } catch (err: unknown) {
      if (!isReceiptNotFound(err)) throw err;
    }
  }

  try {
    const receipt = await rpc.publicClient.getTransactionReceipt({ hash: victimTxHash as Hash });
    return receipt.blockNumber;
  } catch (err: unknown) {
    if (isReceiptNotFound(err)) return null;
    throw err;
  }
}

function isReceiptNotFound(err: unknown): boolean {
  const error = err as { name?: string; message?: string };
  const msg = error.message?.toLowerCase() ?? "";
  return (
    error.name === "TransactionReceiptNotFoundError" ||
    msg.includes("not found") ||
    msg.includes("could not be found")
  );
}

async function fetchBlockWithTransactions(rpc: BackrunRpcContext, blockNumber: bigint) {
  if (rpc.hyperRpc) {
    try {
      const block = await rpc.hyperRpc.getBlockByNumber(blockNumber, true);
      if (block?.transactions) return block;
    } catch {
      // fall through
    }
  }

  return rpc.publicClient.getBlock({
    blockNumber,
    includeTransactions: true,
  });
}

/**
 * Wait for a FastLane bundle to land by watching the victim tx, then scanning its block
 * for a matching operator→executor call. Returns null if the bundle never lands.
 */
export async function waitForBundledBackrunTx(
  rpc: BackrunRpcContext,
  backrun: BackrunContext,
  victimTxHash: string,
  timeoutMs: number,
  pollMs = 250,
): Promise<{ txHash: Hash } | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const blockNumber = await fetchVictimReceiptBlockNumber(rpc, victimTxHash);
    if (blockNumber != null) {
      const block = await fetchBlockWithTransactions(rpc, blockNumber);
      const backrunHash = findBackrunTxInBlock(block.transactions, backrun.operatorAddress, backrun.candidate);
      if (backrunHash) return { txHash: backrunHash };
      return null;
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }

  return null;
}
