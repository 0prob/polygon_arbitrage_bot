import type { PublicClient } from "viem";
import type { StateOverride } from "../../core/types/state-override.ts";
import { mergeStateOverride } from "../../core/types/state-override.ts";

export interface TraceFallbackResult {
  success: boolean;
  stateOverride?: StateOverride;
  affectedPools: string[];
  error?: string;
}

interface DebugTraceCallOptions {
  tracer?: string;
  timeout?: string;
}

interface CallTransaction {
  from?: `0x${string}`;
  to?: `0x${string}`;
  data?: `0x${string}`;
  gas?: `0x${string}`;
  gasPrice?: `0x${string}`;
  value?: `0x${string}`;
}

interface TraceCallResult {
  stateDiff?: Record<string, {
    balance?: { from: string; to: string };
    nonce?: { from: string; to: string };
    code?: { from: string; to: string };
    storage?: Record<string, { from: string; to: string }>;
  }>;
  gasUsed?: number;
  [key: string]: unknown;
}

/**
 * Fallback: extract stateDiff from a pending transaction using debug_traceCall.
 * Used when manual StateOverride construction (StateOverrideBuilder) returns null.
 */
export async function debugTraceCall(
  client: PublicClient,
  tx: { to: string; data: string; from?: string; value?: string },
  opts?: DebugTraceCallOptions,
): Promise<TraceFallbackResult> {
  try {
    const callTx: CallTransaction = {
      to: tx.to as `0x${string}`,
      data: tx.data as `0x${string}`,
    };
    if (tx.from) callTx.from = tx.from as `0x${string}`;
    if (tx.value && tx.value !== "0x0") callTx.value = tx.value as `0x${string}`;

    const tracer = opts?.tracer ?? "prestateTracer";
    const tracerConfig = tracer === "prestateTracer" ? { diffMode: true } : undefined;

    const result = await (client as any).request({
      method: "debug_traceCall",
      params: [
        callTx,
        "pending",
        {
          tracer,
          ...(tracerConfig ? { tracerConfig } : {}),
          timeout: opts?.timeout ?? "5s",
        },
      ],
    }) as TraceCallResult;

    if (!result || !result.stateDiff) {
      return { success: false, affectedPools: [], error: "No stateDiff in trace result" };
    }

    const stateOverride: StateOverride = {};
    const affectedPools: string[] = [];

    for (const [address, diff] of Object.entries(result.stateDiff)) {
      const addr = address.toLowerCase() as `0x${string}`;
      const entry: any = {};
      let hasChanges = false;

      if (diff.storage && Object.keys(diff.storage).length > 0) {
        const stateDiff: Record<string, string> = {};
        for (const [slot, value] of Object.entries(diff.storage)) {
          stateDiff[`0x${slot.replace("0x", "").padStart(64, "0")}`] = value.to;
        }
        entry.stateDiff = stateDiff;
        hasChanges = true;
      }

      if (diff.balance && diff.balance.to !== diff.balance.from) {
        entry.balance = diff.balance.to;
        hasChanges = true;
      }

      if (diff.nonce && diff.nonce.to !== diff.nonce.from) {
        entry.nonce = String(diff.nonce.to);
        hasChanges = true;
      }

      if (diff.code && diff.code.to !== diff.code.from) {
        entry.code = diff.code.to;
        hasChanges = true;
      }

      if (hasChanges) {
        stateOverride[addr] = entry;
        affectedPools.push(addr);
      }
    }

    if (affectedPools.length === 0) {
      return { success: false, affectedPools: [], error: "No state changes found in stateDiff" };
    }

    return { success: true, stateOverride, affectedPools };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, affectedPools: [], error: msg };
  }
}

/**
 * Extract stateDiff for multiple consecutive pending txs.
 * Calls debug_traceCall for each, then merges the state overrides
 * (later txs override earlier ones for the same storage slots).
 */
export async function debugTraceCallBatch(
  client: PublicClient,
  txs: Array<{ to: string; data: string; from?: string; value?: string }>,
  opts?: DebugTraceCallOptions,
): Promise<TraceFallbackResult> {
  const allPools = new Set<string>();
  const merged: StateOverride = {};

  for (const tx of txs) {
    const result = await debugTraceCall(client, tx, opts);
    if (!result.success || !result.stateOverride) continue;

    mergeStateOverride(merged, result.stateOverride);
    for (const addr of Object.keys(result.stateOverride)) {
      allPools.add(addr.toLowerCase());
    }
  }

  return {
    success: allPools.size > 0,
    stateOverride: allPools.size > 0 ? merged : undefined,
    affectedPools: [...allPools],
    error: allPools.size === 0 ? "No storage changes found in any trace" : undefined,
  };
}
