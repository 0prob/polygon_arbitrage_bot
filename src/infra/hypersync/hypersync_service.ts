import type { Logger } from "../observability/logger.ts";
import { ApiTokenPool, createDefaultApiTokenPool } from "./api_token_pool.ts";

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
 * Preferred over the legacy custom JSON-RPC HyperRpcClient for performance-critical
 * read paths (blocks, logs, height). The official client uses the native HyperSync
 * protocol and is significantly faster.
 *
 * Multi-token support:
 *   - Pass multiple tokens (or rely on ENVIO_API_TOKENS / multiple keys in .env files).
 *   - We maintain one native client per token and rotate between them.
 *   - Local pacing (maxRpmPerToken) prevents hammering any single free-tier key up to
 *     the hard wall (which triggers long server backoffs).
 *
 * This directly addresses the "exceeding rate limit blocks everything for a long time"
 * problem: we pace conservatively per key and can spread load across several free keys.
 *
 * See: https://docs.envio.dev/docs/HyperSync/overview (2026 docs)
 */
export class HyperSyncService {
  private clients: Array<{ token: string; client: any }> = [];
  private pool: ApiTokenPool;
  private logger?: Logger;
  private rotationCounter = 0;

  constructor(
    config: {
      url: string;
      /** Single token (legacy) */
      apiToken?: string;
      /** Multiple tokens — enables rotation + multiplied free-tier budget */
      apiTokens?: string[];
      timeoutMs?: number;
      /** Client-side cap: never exceed this many requests per minute *per token*. */
      maxRpmPerToken?: number;
    },
    logger?: Logger,
  ) {
    if (!HypersyncClient) {
      throw new Error("@envio-dev/hypersync-client is not installed. Run `bun install` to get the native modules.");
    }

    const tokens = config.apiTokens?.length
      ? config.apiTokens
      : config.apiToken
        ? [config.apiToken]
        : [];

    this.pool = tokens.length > 0
      ? new ApiTokenPool({ tokens, maxRpmPerToken: config.maxRpmPerToken })
      : createDefaultApiTokenPool(config.maxRpmPerToken);

    if (!this.pool.hasTokens()) {
      // Still create a single unauthenticated client (free public tier)
      const clientConfig = {
        url: config.url,
        apiToken: "",
        httpReqTimeoutMillis: config.timeoutMs ?? 30000,
      };
      this.clients.push({ token: "", client: new HypersyncClient(clientConfig) });
      this.logger?.warn("No HyperSync API tokens found — using unauthenticated public endpoint (very low rate limit)");
    } else {
      const baseCfg = {
        url: config.url,
        httpReqTimeoutMillis: config.timeoutMs ?? 30000,
      };
      for (const tok of this.pool["tokens"] ?? []) {
        // Access private for construction only; pool already holds the list
        this.clients.push({
          token: tok,
          client: new HypersyncClient({ ...baseCfg, apiToken: tok }),
        });
      }
    }

    this.logger = logger;
  }

  /** Returns the pool for external inspection (TUI, logging, etc.) */
  getTokenPool(): ApiTokenPool {
    return this.pool;
  }

  /**
   * Pick a client from the pool, respecting both:
   *  - the native client's waitForRateLimit (server-reported windows per token)
   *  - our local ApiTokenPool pacing (maxRpmPerToken)
   */
  private async pickClient(): Promise<{ token: string; client: any }> {
    // Prefer a token the pool says is safe from our local pacing
    const preferredToken = this.pool.next();
    let chosen = this.clients.find((c) => c.token === preferredToken) ?? this.clients[0];

    // If we have multiple clients, also rotate occasionally so load spreads even under light usage
    if (this.clients.length > 1) {
      this.rotationCounter = (this.rotationCounter + 1) % this.clients.length;
      // Bias toward the pool's suggestion but still rotate
      const rotated = this.clients[this.rotationCounter];
      if (rotated) chosen = rotated;
    }

    // Always wait on the *chosen* client's native rate limiter
    const c = chosen.client;
    if (c?.waitForRateLimit) {
      try {
        await c.waitForRateLimit();
      } catch (err) {
        this.logger?.debug({ err, tokenPrefix: chosen.token?.slice(0, 8) }, "HyperSync waitForRateLimit threw (continuing)");
      }
    }
    return chosen;
  }

  private async withClient<T>(fn: (client: any, token: string) => Promise<T>): Promise<T> {
    const { client, token } = await this.pickClient();
    const result = await fn(client, token);
    // Record the use for local pacing even if the native client did the wait
    this.pool.recordUse(token);
    return result;
  }

  async getHeight(): Promise<number> {
    return this.withClient((c) => c.getHeight());
  }

  async getChainId(): Promise<number> {
    return this.withClient((c) => c.getChainId());
  }

  /**
   * Expose rate limit info from the official client.
   * Call this before expensive operations in hot paths.
   */
  rateLimitInfo(): any | null {
    // Return info from the "current" client in the pool (good enough for observability)
    const active = this.clients[0]?.client ?? this.clients[0];
    return active?.rateLimitInfo?.() ?? null;
  }

  /**
   * Wait until the current rate limit window allows more requests.
   * When using a token pool this waits on one of the clients (the pool already did local pacing selection).
   */
  async waitForRateLimit(): Promise<void> {
    const { client } = await this.pickClient();
    try {
      await client.waitForRateLimit?.();
    } catch {}
  }

  /**
   * Get a recent block with useful fields. Faster than traditional RPC for historical data.
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
      return await this.withClient(async (c) => {
        const res = await c.get(query);
        return res.data.blocks?.[0] ?? null;
      });
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
    const fromBlock = typeof blockNumber === "string" ? undefined : Number(blockNumber);
    const query: any = {
      fromBlock: fromBlock ?? 0,
      toBlock: fromBlock !== undefined ? fromBlock + 1 : undefined,
      fieldSelection: {
        block: ["Number", "Hash", "ParentHash", "Timestamp"],
      },
    };

    try {
      return await this.withClient(async (c) => {
        const res = await c.get(query);
        return res.data.blocks?.[0] ?? null;
      });
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
      return await this.withClient(async (c) => {
        const res = await c.get(query);
        return res.data.logs ?? [];
      });
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
      return await this.withClient(async (c) => {
        const res = await c.get(query);
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
      });
    } catch (err) {
      this.logger?.debug({ err, txHash }, "HyperSync receipt reconstruction failed");
    }
    return null;
  }

  /**
   * Fetch traces for a transaction using HyperSync (very useful for complex arb simulation,
   * sandwich detection, or detailed call tracing without full RPC trace).
   *
   * Inspired by enviodev/hypersync-traces-examples.
   * Supports the native HyperSync trace format.
   */
  async getTransactionTraces(txHash: string, lookbackBlocks = 200): Promise<any[]> {
    try {
      const height = await this.getHeight();
      const query: any = {
        fromBlock: Math.max(0, height - lookbackBlocks),
        fieldSelection: {
          trace: ["BlockNumber", "TransactionHash", "TraceAddress", "Action", "Result", "Error"],
          transaction: ["Hash"],
        },
        transactions: [{ hash: [txHash] }],
        traces: [{}], // Request traces for matching txs
      };
      return await this.withClient(async (c) => {
        const res = await c.get(query);
        return res.data.traces ?? [];
      });
    } catch (err) {
      this.logger?.debug({ err, txHash }, "HyperSync traces fetch failed");
      return [];
    }
  }

  /**
   * Advanced logs query with full control (for custom topic-heavy discovery or monitoring).
   * Uses narrow fieldSelection by default (no joins).
   */
  async queryLogsAdvanced(query: any): Promise<any> {
    try {
      return await this.withClient(async (c) => {
        const res = await c.get(query);
        return res.data;
      });
    } catch (err) {
      this.logger?.warn({ err }, "HyperSync advanced query failed");
      return { logs: [], blocks: [], transactions: [] };
    }
  }
}

// Factory, similar to createHyperRpcClient
export function createHyperSyncService(
  config: {
    url: string;
    apiToken?: string;
    /** Multiple tokens for rotation + multiplied free tier capacity */
    apiTokens?: string[];
    timeoutMs?: number;
    /** Client-side pacing: max requests per minute per token (prevents hard rate limit explosions) */
    maxRpmPerToken?: number;
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
