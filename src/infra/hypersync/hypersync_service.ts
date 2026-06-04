import type { Logger } from "../observability/logger.ts";

// Dynamic import so the rest of the app doesn't break if the native package isn't installed yet.
let HypersyncClient: any;
try {
  HypersyncClient = (await import("@envio-dev/hypersync-client")).HypersyncClient;
} catch {
  // Will be handled at runtime when trying to create the service
}

/**
 * High-level wrapper around the official @envio-dev/hypersync-client.
 *
 * Designed for a single paid Envio API token (starter plan ~200 rpm).
 * Uses the configured ENVIO_API_TOKEN (single).
 *
 * See: https://docs.envio.dev/docs/HyperSync/overview
 */
export class HyperSyncService {
  private client: any;
  private token: string;
  private logger?: Logger;

  constructor(
    config: {
      url: string;
      apiToken?: string;
      timeoutMs?: number;
    },
    logger?: Logger,
  ) {
    if (!HypersyncClient) {
      throw new Error("@envio-dev/hypersync-client is not installed. Run `bun install` to get the native modules.");
    }

    this.token = config.apiToken || "";
    this.logger = logger;

    const clientConfig = {
      url: config.url,
      apiToken: this.token,
      httpReqTimeoutMillis: config.timeoutMs ?? 30000,
      maxNumRetries: 12,
      retryBackoffMs: 500,
      proactiveRateLimitSleep: true,
    };
    this.client = new HypersyncClient(clientConfig);

    if (!this.token) {
      this.logger?.warn("No HyperSync API token provided — using unauthenticated public endpoint (low rate limit)");
    }
  }

  rateLimitInfo(): any | null {
    return this.client?.rateLimitInfo?.() ?? null;
  }

  async waitForRateLimit(): Promise<void> {
    try {
      await this.client.waitForRateLimit?.();
    } catch {}
  }

  async getHeight(): Promise<number> {
    return this.client.getHeight();
  }

  async getChainId(): Promise<number> {
    return this.client.getChainId();
  }

  /**
   * Get a recent block with useful fields.
   */
  async getBlock(numberOrTag: number | "latest" | bigint): Promise<any | null> {
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

  async getBlockByNumber(blockNumber: bigint | number | "latest"): Promise<any | null> {
    let targetBlock: number;
    if (blockNumber === "latest") {
      try {
        targetBlock = await this.getHeight();
      } catch (err) {
        this.logger?.warn({ err }, "HyperSync getBlockByNumber('latest') — getHeight failed, falling back to publicClient");
        return null;
      }
    } else {
      targetBlock = Number(blockNumber);
    }

    const query: any = {
      fromBlock: targetBlock,
      toBlock: targetBlock + 1,
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

  async getLogs(params: {
    fromBlock?: number | bigint;
    toBlock?: number | bigint;
    address?: string | string[];
    topics?: (string | string[] | null)[];
  }): Promise<any[]> {
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

  async getTransactionReceipt(txHash: string, lookbackBlocks = 100): Promise<any | null> {
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
      return null;
    } catch (err) {
      this.logger?.debug({ err, txHash }, "HyperSync receipt reconstruction failed");
    }
    return null;
  }

  async getTransactionTraces(txHash: string, lookbackBlocks = 200): Promise<any[]> {
    try {
      const height = await this.getHeight();
      const query: Record<string, unknown> = {
        fromBlock: Math.max(0, height - lookbackBlocks),
        fieldSelection: {
          trace: ["BlockNumber", "TransactionHash", "TraceAddress", "Action", "Result", "Error", "Value"] as string[],
          transaction: ["Hash"] as string[],
        },
        transactions: [{ hash: [txHash] }],
        traces: [{}],
      };
      const res = await this.client.get(query);
      return res.data.traces ?? [];
    } catch (err) {
      this.logger?.debug({ err, txHash }, "HyperSync traces fetch failed");
      return [];
    }
  }

  async queryLogsAdvanced(query: any): Promise<any> {
    try {
      const res = await this.client.get(query);
      return res.data;
    } catch (err) {
      this.logger?.warn({ err }, "HyperSync advanced query failed");
      return { logs: [], blocks: [], transactions: [] };
    }
  }

  /** Always returns 1 (single token) — kept for compatibility */
  getEnvioTokenPoolSize(): number {
    return this.token ? 1 : 0;
  }
}

// Factory
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
