import { type PublicClient, BaseError, type Hex } from "viem";
import type { CandidateExecution } from "./service.ts";
import { COMPILED_ABIS } from "../../core/abis/compiled/index.ts";
import { ARB_EXECUTOR_ABI } from "../../core/abis/executor.ts";
import { AbiRegistry } from "../../core/abis/registry.ts";

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

const registry = new AbiRegistry();
Object.entries(COMPILED_ABIS).forEach(([tag, abi]) => registry.registerAbi(abi, tag));
registry.registerAbi(ARB_EXECUTOR_ABI, "Executor");

export class MempoolAwareDryRunner {
  private lastPendingState: PendingState | null = null;

  constructor(private client: PublicClient) {}

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
      } catch (err: unknown) {
        let reason = "Unknown revert";
        let revertData: Hex | undefined;
        const error = err as { message?: string; shortMessage?: string; data?: Hex };

        if (err instanceof BaseError) {
          const cause = err.walk((e: unknown) => e instanceof Error && "data" in e);
          if (cause && "data" in cause) {
            revertData = cause.data as Hex;

            const isLockError = revertData.includes("4c4f4b");
            if (isLockError && attempt < MAX_RETRIES - 1) {
              // Add jitter to LOCK retry to avoid synchronized retry storms
              const jitter = Math.floor(Math.random() * 20);
              await new Promise((r) => setTimeout(r, 50 + jitter));
              continue;
            }

            try {
              const decoded = registry.decodeError(revertData);
              if (decoded) {
                const argsStr = decoded.args ? (Array.isArray(decoded.args) ? decoded.args.join(", ") : JSON.stringify(decoded.args)) : "";
                reason = `${decoded.errorName}(${argsStr})`;
              } else {
                reason = error.shortMessage || error.message || "Unknown revert";
              }
            } catch {
              reason = error.shortMessage || error.message || "Unknown revert";
            }
          } else {
            reason = error.shortMessage || error.message || "Unknown revert";
          }
        } else {
          reason = error.message || String(err);
        }

        lastResult = {
          success: false,
          error: error.message || String(err),
          revertReason: reason,
          revertData,
        };

        const isLockError = revertData?.includes("4c4f4b");
        if (!isLockError) break;
      }
    }

    return lastResult!;
  }
}
