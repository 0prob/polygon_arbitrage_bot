import type { Logger } from "../observability/logger.ts";

// Dynamic import so the rest of the app doesn't break if the native package isn't installed yet.
let HypersyncClient: any;
try {
  // @ts-expect-error - optional native dependency
  HypersyncClient = (await import("@envio-dev/hypersync-client")).HypersyncClient;
} catch {
  // Will be handled at runtime when trying to create the service
}

/**
 * High-level wrapper around the official @envio-dev/hypersync-client.
 *
 * Preferred over the legacy custom JSON-RPC HyperRpcClient for performance-critical
 * read paths (blocks, logs, height). The official client uses the native HyperSync
 * protocol and is significantly faster.
 *
 * See: https://docs.envio.dev/docs/HyperSync/overview (2026 docs)
 */
export class HyperSyncService {
  private client: any;
  private logger?: Logger;

  constructor(config: { url: string; apiToken?: string; timeoutMs?: number }, logger?: Logger) {
    if (!HypersyncClient) {
      throw new Error("@envio-dev/hypersync-client is not installed. Run `bun install` to get the native modules.");
    }
    const clientConfig = {
      url: config.url,
      apiToken: config.apiToken || "",
      httpReqTimeoutMillis: config.timeoutMs ?? 30000,
    };
    this.client = new HypersyncClient(clientConfig);
    this.logger = logger;
  }

  /**
   * Internal helper: always respect the HyperSync client's rate limit (including the
   * free tier 100 requests/min unauthenticated limit on hypersync.xyz).
   * This ensures all HyperIndex monitoring, reorg detection, receipt polling, and
   * state fetching automatically comply without callers needing to remember to wait.
   */
  private async waitForRateLimitInternal(): Promise<void> {
    if (this.client?.waitForRateLimit) {
      try {
        await this.client.waitForRateLimit();
      } catch (err) {
        // Non-fatal — the underlying client may throw if the limit info is temporarily unavailable.
        this.logger?.debug({ err }, "HyperSync waitForRateLimit threw (continuing)");
      }
    }
  }

  async getHeight(): Promise<number> {
    await this.waitForRateLimitInternal();
    return this.client.getHeight();
  }

  async getChainId(): Promise<number> {
    await this.waitForRateLimitInternal();
    return this.client.getChainId();
  }

  /**
   * Expose rate limit info from the official client.
   * Call this before expensive operations in hot paths.
   */
  rateLimitInfo(): any | null {
    return this.client.rateLimitInfo?.() ?? null;
  }

  /**
   * Wait until the current rate limit window allows more requests.
   * Use this for backpressure in the monitor, fetcher, and reorg detector.
   */
  async waitForRateLimit(): Promise<void> {
    await this.waitForRateLimitInternal();
  }

  /**
   * Get a recent block with useful fields. Faster than traditional RPC for historical data.
   */
  async getBlock(numberOrTag: number | "latest" | bigint): Promise<any | null> {
    await this.waitForRateLimitInternal();
    const from = typeof numberOrTag === "string" ? 0 : Number(numberOrTag);
    const query: any = {
      fromBlock: from,
      toBlock: typeof numberOrTag === "string" ? undefined : from + 1,
      fieldSelection: {
        block: ["Number", "Hash", "Timestamp", "BaseFeePerGas"],
      },
    };
    try {
      const res = await this.client.get(query);
      return res.data.blocks?.[0] ?? null;
    } catch (err) {
      this.logger?.warn({ err, block: numberOrTag }, "HyperSync getBlock failed");
      return null;
    }
  }

  /**
   * Fetch a single block (simplified, returns partial data).
   * For full fidelity, the legacy HyperRpcClient (JSON-RPC) can still be used alongside.
   */
  async getBlockByNumber(blockNumber: bigint | number | "latest"): Promise<any | null> {
    await this.waitForRateLimitInternal();
    const fromBlock = typeof blockNumber === "string" ? undefined : Number(blockNumber);
    const query: any = {
      fromBlock: fromBlock ?? 0,
      toBlock: fromBlock !== undefined ? fromBlock + 1 : undefined,
      fieldSelection: {
        block: ["Number", "Hash", "ParentHash", "Timestamp"],
      },
    };

    try {
      const res = await this.client.get(query);
      return res.data.blocks?.[0] ?? null;
    } catch (err) {
      this.logger?.warn({ err, blockNumber }, "HyperSync getBlockByNumber failed");
      return null;
    }
  }

  /**
   * High-performance eth_getLogs equivalent using HyperSync.
   *
   * OPTIMIZATION (Point 5): No joinMode is set. By default (and by explicit narrow fieldSelection)
   * we request only the exact log fields needed. This is equivalent to JoinNothing — no automatic
   * pulling of related blocks/transactions/receipts. Matches the "strictly enforce query filters" advice.
   */
  async getLogs(params: {
    fromBlock?: number | bigint;
    toBlock?: number | bigint;
    address?: string | string[];
    topics?: (string | string[] | null)[];
  }): Promise<any[]> {
    await this.waitForRateLimitInternal();
    const query: any = {
      fromBlock: params.fromBlock ? Number(params.fromBlock) : 0,
      toBlock: params.toBlock ? Number(params.toBlock) : undefined,
      logs:
        params.address || params.topics
          ? [
              {
                address: Array.isArray(params.address) ? params.address : params.address ? [params.address] : undefined,
                topics: params.topics,
              },
            ]
          : undefined,
      fieldSelection: {
        log: ["Address", "Topic0", "Topic1", "Topic2", "Topic3", "Data", "BlockNumber", "TransactionHash"],
      },
    };

    try {
      const res = await this.client.get(query);
      return res.data.logs ?? [];
    } catch (err) {
      this.logger?.warn({ err }, "HyperSync getLogs failed");
      return [];
    }
  }

  /**
   * Attempt to get receipt-like data via HyperSync (by scanning recent logs for the tx).
   * This is often faster than RPC for recent transactions. Falls back to null if not found quickly.
   */
  async getTransactionReceipt(txHash: string, lookbackBlocks = 100): Promise<any | null> {
    await this.waitForRateLimitInternal();
    try {
      const height = await this.getHeight();
      const query: any = {
        fromBlock: Math.max(0, height - lookbackBlocks),
        fieldSelection: {
          log: ["BlockNumber", "TransactionHash", "Topics", "Data", "Address"],
          transaction: ["Hash", "Status", "GasUsed"],
        },
        transactions: [{ hash: [txHash] }],
      };
      const res = await this.client.get(query);
      const tx = res.data.transactions?.[0];
      if (tx) {
        return {
          transactionHash: tx.hash,
          status: tx.status === 1 ? "0x1" : "0x0",
          gasUsed: tx.gasUsed,
          logs: res.data.logs?.filter((l: any) => l.transactionHash?.toLowerCase() === txHash.toLowerCase()) ?? [],
        };
      }
    } catch (err) {
      this.logger?.debug({ err, txHash }, "HyperSync receipt reconstruction failed");
    }
    return null;
  }
}

// Factory, similar to createHyperRpcClient
export function createHyperSyncService(
  config: {
    url: string;
    apiToken?: string;
    timeoutMs?: number;
  },
  logger?: Logger,
): HyperSyncService | undefined {
  if (!config.url) return undefined;
  if (!HypersyncClient) {
    logger?.warn("@envio-dev/hypersync-client not available yet (install may still be running). Falling back to legacy HyperRPC paths.");
    return undefined;
  }
  try {
    return new HyperSyncService(config, logger);
  } catch (err) {
    logger?.warn({ err }, "Failed to initialize HyperSyncService. Using legacy paths.");
    return undefined;
  }
}
