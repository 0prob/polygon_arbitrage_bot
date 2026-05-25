import type { PublicClient } from "viem";
import type { CandidateExecution } from "./service.ts";

export interface DryRunResult {
  success: boolean;
  gasUsed?: bigint;
  revertReason?: string;
  error?: string;
}

export interface PendingState {
  blockNumber: number;
  blockHash: string;
}

export class MempoolAwareDryRunner {
  private lastPendingState: PendingState | null = null;

  constructor(
    private client: PublicClient,
  ) {}

  async fetchPendingState(): Promise<PendingState | null> {
    try {
      const block = await this.client.getBlock({ blockTag: "pending" });
      if (block.number && block.hash) {
        this.lastPendingState = {
          blockNumber: Number(block.number),
          blockHash: block.hash,
        };
        return this.lastPendingState;
      }
    } catch { /* ignore */ }
    return null;
  }

  getLastPendingState(): PendingState | null {
    return this.lastPendingState;
  }

  async dryRun(candidate: CandidateExecution, fromAddress: string): Promise<DryRunResult> {
    try {
      const result = await this.client.call({
        account: fromAddress as `0x${string}`,
        to: candidate.targetAddress as `0x${string}`,
        data: candidate.calldata as `0x${string}`,
        value: candidate.value,
        blockTag: "pending",
      });

      if (result && result.data) {
        const gasEstimate = await this.client.estimateGas({
          account: fromAddress as `0x${string}`,
          to: candidate.targetAddress as `0x${string}`,
          data: candidate.calldata as `0x${string}`,
          value: candidate.value,
        }).catch(() => 500_000n);

        return {
          success: true,
          gasUsed: gasEstimate,
        };
      }
      return { success: false, error: "no return data" };
    } catch (err: any) {
      const msg = err?.message || String(err);
      // Extract revert reason if available
      const revertMatch = msg.match(/reverted with reason string '(.+?)'/);
      const reason = revertMatch ? revertMatch[1] : msg;
      return { success: false, error: msg, revertReason: reason };
    }
  }
}
