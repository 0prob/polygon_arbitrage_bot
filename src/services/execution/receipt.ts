import type { RpcManager } from "../../rpc/manager.ts";
import type { HyperRpcClient } from "../../infra/rpc/hyperrpc.ts";
import type { HyperSyncService } from "../../infra/hypersync/hypersync_service.ts";
import { safeParseTraces, type ParsedTraceSummary } from "../../infra/hypersync/trace_parser.ts";

export interface ReceiptData {
  status: boolean;
  gasUsed: bigint;
  logs: Array<{ topics: string[]; data: string }>;
  traces?: any[];
  traceSummary?: ParsedTraceSummary; // Parsed high-signal summary (see trace_parser.ts)
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

        let receipt: any = null;

        if (hyperSync) {
          receipt = await hyperSync.getTransactionReceipt(txHash);
          // Improvement from enviodev audit: also pull traces for complex tx analysis (sandwiches, internal calls).
          if (receipt) {
            (receipt as any).traces = await hyperSync.getTransactionTraces(txHash).catch(() => []);
          }
        }
        if (!receipt && hyperRpc) {
          receipt = await hyperRpc.getTransactionReceipt(txHash as `0x${string}`);
        }
        if (!receipt) {
          receipt = await this.rpc.read.getTransactionReceipt({ hash: txHash as `0x${string}` });
        }

        if (receipt) {
          const rawTraces = (receipt as any).traces ?? [];
          const traceSummary = rawTraces.length > 0 ? safeParseTraces(txHash, rawTraces) : undefined;

          return {
            status: (receipt as any).status === "0x1" || (receipt as any).status === true || (receipt as any).status === "success",
            gasUsed: BigInt((receipt as any).gasUsed ?? 0),
            logs: (receipt as any).logs ?? [],
            traces: rawTraces,
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
