import type { PublicClient, StateOverride } from "viem";
import type { StateOverride as InternalStateOverride, BuildOverrideInput } from "../../core/types/state-override.ts";
import { buildStateOverride } from "./state-override-builder.ts";
import { debugTraceCall } from "./trace-fallback.ts";
import { PendingOverrideStore } from "./pending-override.ts";
import type { PoolState } from "../../core/types/pool.ts";
import type { Address } from "../../core/types/common.ts";
import { toViemStateOverride } from "../../core/types/state-override.ts";

export interface MempoolSimulatorOptions {
  client: PublicClient;
  stateCache: Map<string, PoolState>;
  overrideStore?: PendingOverrideStore;
  poolManagerAddress?: Address;
}

export interface MempoolOverrideResult {
  success: boolean;
  stateOverride?: InternalStateOverride;
  affectedPools: string[];
  method: "manual" | "trace";
  error?: string;
}

/**
 * Orchestrates mempool-aware simulation using Geth state overrides.
 *
 * Flow:
 * 1. Decode pending swap → BuildOverrideInput
 * 2. Try manual StateOverride construction (per-protocol, uses simulator math)
 * 3. Fallback: debug_traceCall with stateDiff tracer
 * 4. Merge into PendingOverrideStore
 * 5. Expose stateOverride for use in client.call({ stateOverride })
 */
export class MempoolSimulator {
  private client: PublicClient;
  private stateCache: Map<string, PoolState>;
  private poolManagerAddress: Address | undefined;

  constructor(opts: MempoolSimulatorOptions) {
    this.client = opts.client;
    this.stateCache = opts.stateCache;
    this.poolManagerAddress = opts.poolManagerAddress;
  }

  /**
   * Build a StateOverride for a single pending swap.
   * Tries manual construction first, falls back to debug_traceCall.
   */
  async buildOverride(
    poolAddress: Address,
    protocol: string,
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint,
    tx: { to: string; data: string; from?: string; value?: string },
    extras?: Partial<BuildOverrideInput>,
  ): Promise<MempoolOverrideResult> {
    const currentState = this.stateCache.get(poolAddress.toLowerCase());
    if (!currentState) {
      return { success: false, affectedPools: [], method: "manual", error: "No state in cache for pool" };
    }

    const input: BuildOverrideInput = {
      poolAddress,
      protocol,
      tokenIn,
      tokenOut,
      amountIn,
      zeroForOne: extras?.zeroForOne,
      fee: extras?.fee,
      swapFeeBps: extras?.swapFeeBps,
      tokenInIdx: extras?.tokenInIdx,
      tokenOutIdx: extras?.tokenOutIdx,
      poolId: extras?.poolId,
      currentState,
      poolManagerAddress: this.poolManagerAddress ?? extras?.poolManagerAddress,
      currency0: extras?.currency0,
      currency1: extras?.currency1,
      hooks: extras?.hooks,
      tickSpacing: extras?.tickSpacing,
    };

    const manual = buildStateOverride(input);
    if (manual) {
      return { success: true, stateOverride: manual, affectedPools: [poolAddress.toLowerCase()], method: "manual" };
    }

    const trace = await debugTraceCall(this.client, tx);
    if (trace.success && trace.stateOverride) {
      return { success: true, stateOverride: trace.stateOverride, affectedPools: trace.affectedPools, method: "trace" };
    }

    return {
      success: false,
      affectedPools: [],
      method: "trace",
      error: `Manual failed, trace failed: ${trace.error}`,
    };
  }

  /**
   * Execute a client.call against the pending state with overrides applied.
   * This simulates the arb tx as if the pending swap already executed.
   */
  async simulateWithOverride(
    arbTx: { to: `0x${string}`; data: `0x${string}`; value: bigint },
    fromAddress: `0x${string}`,
    stateOverride: InternalStateOverride,
  ): Promise<{ success: boolean; data?: `0x${string}`; error?: string; gasUsed?: number }> {
    const viemOverride = toViemStateOverride(stateOverride) as StateOverride;
    try {
      const result = await this.client.call({
        account: fromAddress,
        to: arbTx.to,
        data: arbTx.data,
        value: arbTx.value,
        stateOverride: viemOverride,
        blockTag: "pending",
      });
      return { success: true, data: result.data as `0x${string}` | undefined };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }
}
