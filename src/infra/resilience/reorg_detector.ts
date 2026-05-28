import type { PublicClient } from "viem";
import type { HyperRpcClient } from "../rpc/hyperrpc.ts";
import type { HyperSyncService } from "../hypersync/hypersync_service.ts";

export interface BlockInfo {
  number: number;
  hash: string;
  parentHash: string;
  timestamp: number;
}

const MAX_TRACKED_BLOCKS = 200;

export class ReorgDetector {
  private trackedBlocks: BlockInfo[] = [];
  private lastSafeBlock = 0;
  private reorgedBlocks = new Set<number>();

  constructor(
    private client: PublicClient,
    private checkDepth: number = 10,
    /** Read-only HyperRPC client (optional, for JSON-RPC compatibility) */
    private hyperRpc?: HyperRpcClient,
    /** Preferred: Official high-performance HyperSync client */
    private hyperSync?: HyperSyncService,
  ) {}

  async trackBlock(blockNumber: number, blockHash: string): Promise<void> {
    const parent = this.trackedBlocks.find((b) => b.number === blockNumber - 1);
    let parentHash = "";
    if (parent) {
      parentHash = parent.hash;
    } else {
      try {
        const block = this.hyperSync
          ? await this.hyperSync.getBlockByNumber(BigInt(blockNumber - 1))
          : this.hyperRpc
            ? await this.hyperRpc.getBlockByNumber(BigInt(blockNumber - 1))
            : await this.client.getBlock({ blockNumber: BigInt(blockNumber - 1) });
        parentHash = (block?.hash as string) ?? "";
      } catch {
        /* ignore */
      }
    }
    this.trackedBlocks.push({
      number: blockNumber,
      hash: blockHash,
      parentHash,
      timestamp: Date.now(),
    });
    if (this.trackedBlocks.length > MAX_TRACKED_BLOCKS) {
      this.trackedBlocks.shift();
    }
  }

  async checkReorg(): Promise<Set<number>> {
    const reorged = new Set<number>();
    const latest = this.trackedBlocks[this.trackedBlocks.length - 1];
    if (!latest) return reorged;

    // We check from the latest block down to checkDepth
    for (let depth = 0; depth <= this.checkDepth; depth++) {
      const blockNum = latest.number - depth;
      if (blockNum < 0) break;

      const tracked = this.trackedBlocks.find((b) => b.number === blockNum);
      if (!tracked) continue;

      try {
        const block = this.hyperSync
          ? await this.hyperSync.getBlockByNumber(BigInt(blockNum))
          : this.hyperRpc
            ? await this.hyperRpc.getBlockByNumber(BigInt(blockNum))
            : await this.client.getBlock({ blockNumber: BigInt(blockNum) });
        const blockHash = (block?.hash as string | undefined)?.toLowerCase();
        if (blockHash && blockHash !== tracked.hash.toLowerCase()) {
          // Reorg detected at this height
          reorged.add(blockNum);
          this.reorgedBlocks.add(blockNum);
          this.lastSafeBlock = Math.min(this.lastSafeBlock, blockNum - 1);

          // All blocks from this point forward in our tracked list are potentially invalid
          for (const tb of this.trackedBlocks) {
            if (tb.number >= blockNum) {
              reorged.add(tb.number);
              this.reorgedBlocks.add(tb.number);
            }
          }
          break; // Found the fork point
        }
      } catch {
        /* skip this depth if RPC fails */
      }
    }

    if (reorged.size === 0) {
      this.lastSafeBlock = latest.number;
    }

    return reorged;
  }

  getLastSafeBlock(): number {
    return this.lastSafeBlock;
  }

  isBlockReorged(blockNumber: number): boolean {
    return this.reorgedBlocks.has(blockNumber);
  }

  clearReorged(): void {
    this.reorgedBlocks.clear();
  }

  getTrackedBlocks(): BlockInfo[] {
    return [...this.trackedBlocks];
  }

  prune(olderThanMs: number): void {
    const cutoff = Date.now() - olderThanMs;
    this.trackedBlocks = this.trackedBlocks.filter((b) => b.timestamp >= cutoff);
    this.reorgedBlocks.clear();
  }
}
