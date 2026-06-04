import type { RpcManager } from "../../rpc/manager.ts";
import type { HyperRpcClient } from "../../infra/rpc/hyperrpc.ts";
import type { HyperSyncService } from "../../infra/hypersync/hypersync_service.ts";
import { safeParseTraces, type ParsedTraceSummary } from "../../infra/hypersync/trace_parser.ts";

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

function normalizeReceipt(receipt: RawReceipt): ReceiptData {
  return {
    status: receipt.status === "0x1" || receipt.status === true || receipt.status === "success",
    gasUsed: BigInt(receipt.gasUsed ?? 0),
    logs: receipt.logs ?? [],
    traces: receipt.traces,
  };
}

export class ReceiptPoller {
  constructor(
    private rpc: RpcManager,
    private timeoutMs: number,
    private pollMs: number,
  ) {}

  async wait(txHash: string): Promise<ReceiptData | null> {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      try {
        const hyperSync = this.rpc.hyperSync as HyperSyncService | undefined;
        const hyperRpc = this.rpc.hyperRpc as HyperRpcClient | undefined;

        let receipt: RawReceipt | null = null;

        if (hyperSync) {
          receipt = await hyperSync.getTransactionReceipt(txHash) as RawReceipt | null;
          if (receipt) {
            receipt.traces = await hyperSync.getTransactionTraces(txHash).catch(() => []);
          }
        }
        if (!receipt && hyperRpc) {
          receipt = await hyperRpc.getTransactionReceipt(txHash as `0x${string}`) as RawReceipt | null;
        }
        if (!receipt) {
          const viemReceipt = await this.rpc.read.getTransactionReceipt({ hash: txHash as `0x${string}` });
          receipt = {
            status: viemReceipt.status,
            gasUsed: viemReceipt.gasUsed,
            logs: viemReceipt.logs as Array<{ topics: string[]; data: string }>,
          };
        }

        if (receipt) {
          const rawTraces = receipt.traces ?? [];
          const traceSummary = rawTraces.length > 0 ? safeParseTraces(txHash, rawTraces) : undefined;

          return {
            ...normalizeReceipt(receipt),
            traceSummary,
          };
        }
      } catch {
        // Receipt not yet available
      }
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
    return null;
  }
}
