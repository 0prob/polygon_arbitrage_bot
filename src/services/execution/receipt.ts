import type { RpcManager } from "../../rpc/manager.ts";

export interface ReceiptData {
  status: boolean;
  gasUsed: bigint;
  logs: Array<{ topics: string[]; data: string }>;
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
        const receipt = await this.rpc.read.getTransactionReceipt({ hash: txHash as `0x${string}` });
        if (receipt) {
          return { status: receipt.status === "success", gasUsed: receipt.gasUsed, logs: (receipt as any).logs ?? [] };
        }
      } catch (_err: unknown) {
        // Receipt not yet available
      }
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
    return null;
  }
}
