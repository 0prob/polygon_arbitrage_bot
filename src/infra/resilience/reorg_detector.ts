import type { PublicClient } from "viem";

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
  ) {}

  async trackBlock(blockNumber: number, blockHash: string): Promise<void> {
    const parent = this.trackedBlocks.find(b => b.number === blockNumber - 1);
    let parentHash = "";
    if (parent) {
      parentHash = parent.hash;
    } else {
      try {
        const block = await this.client.getBlock({ blockNumber: BigInt(blockNumber - 1) });
        parentHash = block.hash ?? "";
      } catch { /* ignore */ }
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

    const start = Math.max(0, latest.number - this.checkDepth);
    const targets = this.trackedBlocks.filter(b => b.number >= start);
    if (targets.length < 2) return reorged;

    try {
      const current = await this.client.getBlock({ blockNumber: BigInt(latest.number) });
      if (!current.hash || current.hash.toLowerCase() === latest.hash.toLowerCase()) {
        this.lastSafeBlock = latest.number;
        return reorged;
      }

      for (let depth = 1; depth <= this.checkDepth; depth++) {
        const blockNum = latest.number - depth;
        if (blockNum < 0) break;
        const tracked = this.trackedBlocks.find(b => b.number === blockNum);
        if (!tracked) continue;
        try {
          const block = await this.client.getBlock({ blockNumber: BigInt(blockNum) });
          if (block.hash && block.hash.toLowerCase() !== tracked.hash.toLowerCase()) {
            reorged.add(blockNum);
            this.reorgedBlocks.add(blockNum);
            this.lastSafeBlock = blockNum - 1;
            for (const tb of this.trackedBlocks) {
              if (tb.number >= blockNum) reorged.add(tb.number);
            }
          }
        } catch { /* skip */ }
        if (reorged.size > 0) break;
      }
    } catch { /* skip */ }

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
    this.trackedBlocks = this.trackedBlocks.filter(b => b.timestamp >= cutoff);
    this.reorgedBlocks.clear();
  }
}
