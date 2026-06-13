import type { RpcManager } from "../../rpc/manager.ts";
import type { HyperRpcClient } from "../../infra/rpc/hyperrpc.ts";
import type { HyperSyncService } from "../../infra/hypersync/hypersync_service.ts";
import { safeParseTraces, type ParsedTraceSummary } from "../../infra/hypersync/trace_parser.ts";
import type { Logger } from "../../infra/observability/logger.ts";

interface RawReceipt {
  status?: string | boolean;
  gasUsed?: string | bigint;
  logs?: Array<{ topics: string[]; data: string }>;
  traces?: unknown[];
}

export interface ReceiptData {
  status: boolean;
  gasUsed: bigint;
  logs: Array<{ topics: string[]; data: string }>;
  traces?: unknown[];
  traceSummary?: ParsedTraceSummary;
}

type ReceiptSource = "hypersync" | "hyperrpc" | "viem";

const ALL_SOURCES: ReceiptSource[] = ["hyperrpc", "hypersync", "viem"];

function normalizeReceipt(receipt: RawReceipt): ReceiptData {
  return {
    status: receipt.status === "0x1" || receipt.status === true || receipt.status === "success",
    gasUsed: BigInt(receipt.gasUsed ?? 0),
    logs: receipt.logs ?? [],
    traces: receipt.traces,
  };
}

export class ReceiptPoller {
  private abortController = new AbortController();
  /** Sticky fast path — set after the first successful fetch for this poller instance. */
  private preferredSource: ReceiptSource | null = null;

  constructor(
    private logger: Logger,
    private rpc: RpcManager,
    private timeoutMs: number,
    private pollMs: number,
    /** When true, fetch execution traces via HyperSync (doubles API cost). */
    private fetchTraces = false,
  ) {}

  public cancel(): void {
    this.abortController.abort();
  }

  private sourceOrder(): ReceiptSource[] {
    if (!this.preferredSource) return ALL_SOURCES;
    return [this.preferredSource, ...ALL_SOURCES.filter((s) => s !== this.preferredSource)];
  }

  private async fetchFromSource(source: ReceiptSource, txHash: string): Promise<RawReceipt | null> {
    if (source === "hypersync") {
      const hyperSync = this.rpc.hyperSync as HyperSyncService | undefined;
      if (!hyperSync) return null;
      const receipt = (await hyperSync.getTransactionReceipt(txHash)) as RawReceipt | null;
      if (receipt && this.fetchTraces) {
        receipt.traces = await hyperSync.getTransactionTraces(txHash).catch(() => []);
      }
      return receipt;
    }

    if (source === "hyperrpc") {
      const hyperRpc = this.rpc.hyperRpc as HyperRpcClient | undefined;
      if (!hyperRpc) return null;
      return (await hyperRpc.getTransactionReceipt(txHash as `0x${string}`)) as RawReceipt | null;
    }

    const viemReceipt = await this.rpc.read.getTransactionReceipt({ hash: txHash as `0x${string}` });
    return {
      status: viemReceipt.status,
      gasUsed: viemReceipt.gasUsed,
      logs: viemReceipt.logs as Array<{ topics: string[]; data: string }>,
    };
  }

  private async fetchReceipt(txHash: string): Promise<ReceiptData | null> {
    for (const source of this.sourceOrder()) {
      try {
        const receipt = await this.fetchFromSource(source, txHash);
        if (!receipt) continue;

        this.preferredSource = source;
        const rawTraces = receipt.traces ?? [];
        const traceSummary = rawTraces.length > 0 ? safeParseTraces(txHash, rawTraces) : undefined;
        return {
          ...normalizeReceipt(receipt),
          traceSummary,
        };
      } catch (err: unknown) {
        const error = err as { message?: string; name?: string };
        const msg = error.message?.toLowerCase() || "";
        const isNotFound =
          msg.includes("not found") ||
          msg.includes("could not be found") ||
          error.name === "TransactionReceiptNotFoundError";
        if (isNotFound) return null;
        throw err;
      }
    }
    return null;
  }

  async wait(txHash: string): Promise<ReceiptData | null> {
    const deadline = Date.now() + this.timeoutMs;
    const signal = this.abortController.signal;
    let hardErrorCount = 0;

    while (Date.now() < deadline) {
      if (signal.aborted) {
        this.logger.debug({ txHash }, "ReceiptPoller cancelled");
        return null;
      }
      try {
        const receipt = await this.fetchReceipt(txHash);
        if (receipt) return receipt;
        hardErrorCount = 0;
      } catch (err: unknown) {
        const error = err as { message?: string };
        hardErrorCount++;
        if (hardErrorCount >= 5) {
          this.logger.error({ txHash, error: error.message, hardErrorCount }, "Persistent RPC error in ReceiptPoller — giving up");
          return null;
        }
      }
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
    return null;
  }
}
