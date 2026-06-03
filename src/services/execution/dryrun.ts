import { decodeErrorResult, type PublicClient, BaseError, type Hex } from "viem";
import type { CandidateExecution } from "./service.ts";
import { EXECUTOR_ABI, EXECUTOR_AAVE_ABI, V2_PAIR_SWAP_ABI, V3_POOL_SWAP_ABI, BALANCER_VAULT_SWAP_ABI } from "./calldata/abis.ts";

export interface DryRunResult {
  success: boolean;
  gasUsed?: bigint;
  revertReason?: string;
  error?: string;
  revertData?: Hex;
}

export interface PendingState {
  blockNumber: number;
  blockHash: string;
}

// Combine relevant ABIs for decoding common reverts
const DECODABLE_ABIS = [...EXECUTOR_ABI, ...EXECUTOR_AAVE_ABI, ...V2_PAIR_SWAP_ABI, ...V3_POOL_SWAP_ABI, ...BALANCER_VAULT_SWAP_ABI];

export interface PredictionResult {
  predictedBlock: number;
  expectedSqrtPriceX96: Record<string, bigint>;
  expectedLiquidity: Record<string, bigint>;
}

export class MempoolAwareDryRunner {
  private lastPendingState: PendingState | null = null;

  constructor(private client: PublicClient) {}

  /**
   * Project the state of specific pools based on mempool activity.
   * This is a "Step 3" feature that anticipates price moves.
   */
  async predictState(poolAddresses: string[]): Promise<PredictionResult> {
    const block = await this.fetchPendingState();
    const result: PredictionResult = {
      predictedBlock: (block?.blockNumber || 0) + 1,
      expectedSqrtPriceX96: {},
      expectedLiquidity: {},
    };

    // For now, we simply fetch the latest pending state.
    // In a full implementation, we would decode mempool transactions
    // that target these poolAddresses and apply them.
    for (const addr of poolAddresses) {
      const state = (await this.client
        .readContract({
          address: addr as `0x${string}`,
          abi: V3_POOL_SWAP_ABI,
          functionName: "slot0",
        })
        .catch(() => null)) as any;

      if (state) {
        result.expectedSqrtPriceX96[addr.toLowerCase()] = state[0];
      }
    }

    return result;
  }

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
    } catch {
      /* ignore */
    }
    return null;
  }

  getLastPendingState(): PendingState | null {
    return this.lastPendingState;
  }

  async dryRun(candidate: CandidateExecution, fromAddress: string): Promise<DryRunResult> {
    const MAX_RETRIES = 3;
    let lastResult: DryRunResult | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        await this.client.call({
          account: fromAddress as `0x${string}`,
          to: candidate.targetAddress as `0x${string}`,
          data: candidate.calldata as `0x${string}`,
          value: candidate.value,
          blockTag: "pending",
        });

        const gasEstimate = await this.client
          .estimateGas({
            account: fromAddress as `0x${string}`,
            to: candidate.targetAddress as `0x${string}`,
            data: candidate.calldata as `0x${string}`,
            value: candidate.value,
          })
          .catch(() => 500_000n);

        return {
          success: true,
          gasUsed: gasEstimate,
        };
      } catch (err: any) {
        let reason = "Unknown revert";
        let revertData: Hex | undefined;

        if (err instanceof BaseError) {
          const revertError = err.walk((e) => (e as any).data !== undefined) as any;
          if (revertError?.data) {
            revertData = revertError.data;

            // Uniswap V3 'LOK' (Locked) - often a string revert "LOK"
            const isLockError = revertData?.includes("4c4f4b"); // "LOK" in hex
            if (isLockError && attempt < MAX_RETRIES - 1) {
              await new Promise((r) => setTimeout(r, 50));
              continue;
            }

            try {
              const decoded = decodeErrorResult({
                abi: DECODABLE_ABIS,
                data: revertData!,
              });
              reason = `${decoded.errorName}(${decoded.args?.join(", ") || ""})`;
            } catch {
              reason = err.shortMessage || err.message;
            }
          } else {
            reason = err.shortMessage || err.message;
          }
        } else {
          reason = err?.message || String(err);
        }

        lastResult = {
          success: false,
          error: err?.message || String(err),
          revertReason: reason,
          revertData,
        };

        // Only retry on lock errors
        const isLockError = revertData?.includes("4c4f4b");
        if (!isLockError) break;
      }
    }

    return lastResult!;
  }
}
