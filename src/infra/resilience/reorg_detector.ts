import type { PublicClient } from "viem";
import type { HyperRpcClient } from "../rpc/hyperrpc.ts";
import type { HyperSyncService } from "../hypersync/hypersync_service.ts";
import { normalizeBlockHash } from "../../core/utils/normalize.ts";

export { normalizeBlockHash } from "../../core/utils/normalize.ts";

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

  private async getBlockByNumber(blockNumber: bigint) {
    // Prefer HyperRPC (cheap JSON-RPC, 100ms cache) over HyperSync to preserve
    // the shared ENVIO_API_TOKEN quota for the HyperIndex child process.
    if (this.hyperRpc) {
      try {
        return await this.hyperRpc.getBlockByNumber(blockNumber);
      } catch {
        // fall through
      }
    }
    if (this.hyperSync) {
      try {
        return await this.hyperSync.getBlockByNumber(blockNumber);
      } catch {
        // fall through to public RPC
      }
    }
    return this.client.getBlock({ blockNumber });
  }

  /**
   * Detect fork before mutating tracked chain: WS newHead parent must link to block N-1 we already saw.
   */
  checkLocalParentMismatch(blockNumber: number, parentHash: string): boolean {
    if (blockNumber <= 0 || !parentHash) return false;
    const parent = this.trackedBlocks.find((b) => b.number === blockNumber - 1);
    if (!parent) return false;
    return normalizeBlockHash(parentHash) !== parent.hash;
  }

  async trackBlock(blockNumber: number, blockHash: string, parentHashHint?: string): Promise<void> {
    const parent = this.trackedBlocks.find((b) => b.number === blockNumber - 1);
    let parentHash = "";
    if (parent) {
      parentHash = parent.hash;
    } else if (parentHashHint) {
      parentHash = parentHashHint;
    } else {
      try {
        const block = await this.getBlockByNumber(BigInt(blockNumber - 1));
        parentHash = (block?.hash as string) ?? "";
      } catch (err) {
        console.warn("[reorg-detector] Failed to fetch parent block:", err);
      }
    }
    const normalizedHash = normalizeBlockHash(blockHash);
    const normalizedParent = parentHash ? normalizeBlockHash(parentHash) : "";
    const existingIdx = this.trackedBlocks.findIndex((b) => b.number === blockNumber);
    const entry: BlockInfo = {
      number: blockNumber,
      hash: normalizedHash,
      parentHash: normalizedParent,
      timestamp: Date.now(),
    };
    if (existingIdx >= 0) {
      this.trackedBlocks[existingIdx] = entry;
    } else {
      this.trackedBlocks.push(entry);
      if (this.trackedBlocks.length > MAX_TRACKED_BLOCKS) {
        this.trackedBlocks.shift();
      }
    }
  }

  /** Drop tracked entries at/above a reorg fork height (canonical chain replaced them). */
  private pruneTrackedFrom(blockNumber: number): void {
    this.trackedBlocks = this.trackedBlocks.filter((b) => b.number < blockNumber);
  }

  async checkReorg(chainTip?: { number: number; hash: string }): Promise<Set<number>> {
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
        let blockHash: string | undefined;
        if (depth === 0 && chainTip && chainTip.number === blockNum) {
          blockHash = normalizeBlockHash(chainTip.hash);
        } else {
          const block = await this.getBlockByNumber(BigInt(blockNum));
          const raw = block?.hash as string | undefined;
          blockHash = raw ? normalizeBlockHash(raw) : undefined;
        }
        if (blockHash && blockHash !== tracked.hash) {
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
          this.pruneTrackedFrom(blockNum);
          break; // Found the fork point
        }
      } catch (err) {
        console.warn("[reorg-detector] Failed to fetch block at depth:", err);
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
