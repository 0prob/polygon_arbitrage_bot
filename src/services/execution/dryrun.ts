import { type PublicClient, BaseError, type Hex, type StateOverride as ViemStateOverride } from "viem";
import type { CandidateExecution } from "./service.ts";
import { COMPILED_ABIS } from "../../core/abis/compiled/index.ts";
import { ARB_EXECUTOR_ABI } from "../../core/abis/executor.ts";
import { AbiRegistry } from "../../core/abis/registry.ts";
import { PendingOverrideStore } from "../mempool/pending-override.ts";
import { toViemStateOverride } from "../../core/types/state-override.ts";

export interface DryRunResult {
  success: boolean;
  gasUsed?: bigint;
  revertReason?: string;
  error?: string;
  revertData?: Hex;
}

const registry = new AbiRegistry();
Object.entries(COMPILED_ABIS).forEach(([tag, abi]) => registry.registerAbi(abi, tag));
registry.registerAbi(ARB_EXECUTOR_ABI, "Executor");

export class MempoolAwareDryRunner {
  constructor(
    private client: PublicClient,
    private pendingOverrideStore?: PendingOverrideStore,
  ) {}

  private getViemOverride(): ViemStateOverride | undefined {
    const merged = this.pendingOverrideStore?.get();
    if (!merged) return undefined;
    return toViemStateOverride(merged) as ViemStateOverride;
  }

  async dryRun(candidate: CandidateExecution, fromAddress: string): Promise<DryRunResult> {
    const MAX_RETRIES = 3;
    let lastResult: DryRunResult | null = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const viemOverride = this.getViemOverride();
      try {
        const gasUsed = await this.estimateGas(fromAddress, candidate, viemOverride);
        return { success: true, gasUsed };
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
            } catch (decodeErr) {
              console.warn("[dryrun] Failed to decode revert data:", decodeErr);
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

  private estimateGas(
    fromAddress: string,
    candidate: CandidateExecution,
    viemOverride?: ViemStateOverride,
  ): Promise<bigint> {
    const params = {
      account: fromAddress as `0x${string}`,
      to: candidate.targetAddress as `0x${string}`,
      data: candidate.calldata as `0x${string}`,
      value: candidate.value,
      blockTag: "pending" as const,
      ...(viemOverride ? { stateOverride: viemOverride } : {}),
    };
    return this.client.estimateGas(params);
  }
}
