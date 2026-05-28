/**
 * HyperRPC client — high-performance, **READ-ONLY** JSON-RPC provider (Envio / HyperSync team).
 *
 * IMPORTANT: HyperRPC is strictly read-only. It must **never** be used for any of the following:
 *   - eth_sendRawTransaction / eth_sendTransaction
 *   - eth_estimateGas (in some configurations)
 *   - eth_call that expects state changes / simulation for execution
 *   - Any write or mutating operation
 *
 * This client only implements the following **read** methods:
 *   - eth_chainId
 *   - eth_blockNumber
 *   - eth_getBlockByNumber
 *   - eth_getBlockByHash
 *   - eth_getBlockReceipts
 *   - eth_getTransactionByHash
 *   - eth_getTransactionByBlockHashAndIndex
 *   - eth_getTransactionByBlockNumberAndIndex
 *   - eth_getTransactionReceipt
 *   - eth_getLogs
 *
 * When a paid HYPERRPC_API_TOKEN is supplied, the bot prefers this client for the
 * above methods because of significantly better performance and reliability compared
 * to normal RPC providers.
 *
 * This implementation uses native fetch with no extra dependencies for minimal overhead.
 */

export interface HyperRpcConfig {
  url?: string;
  apiToken?: string;
  timeoutMs?: number;
  chainId?: number; // For constructing per-chain endpoints like https://137.rpc.hypersync.xyz
}

export interface HyperRpcBlock {
  number: `0x${string}` | null;
  hash: `0x${string}` | null;
  parentHash: `0x${string}`;
  timestamp: `0x${string}`;
  [key: string]: unknown;
}

export interface HyperRpcTransaction {
  hash: `0x${string}`;
  blockHash: `0x${string}` | null;
  blockNumber: `0x${string}` | null;
  transactionIndex: `0x${string}` | null;
  [key: string]: unknown;
}

export interface HyperRpcReceipt {
  transactionHash: `0x${string}`;
  blockHash: `0x${string}` | null;
  blockNumber: `0x${string}` | null;
  [key: string]: unknown;
}

export interface HyperRpcLog {
  address: `0x${string}`;
  topics: `0x${string}`[];
  data: `0x${string}`;
  blockNumber: `0x${string}` | null;
  transactionHash: `0x${string}` | null;
  [key: string]: unknown;
}

export class HyperRpcClient {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private requestId = 0;

  constructor(config: HyperRpcConfig = {}) {
    const token = config.apiToken?.trim();
    const chainId = config.chainId ?? 137; // Default Polygon

    if (config.url) {
      // User-provided override (advanced)
      this.endpoint = token && !config.url.includes(token) ? `${config.url.replace(/\/$/, "")}/${token}` : config.url;
    } else if (token) {
      // Recommended per docs (2026): per-chain or unified with token appended
      // Unified high-performance: https://rpc.hypersync.xyz/<token>
      // Or per-chain: https://137.rpc.hypersync.xyz/<token>
      this.endpoint = `https://rpc.hypersync.xyz/${token}`;
    } else {
      // Public (rate-limited) default for Polygon
      this.endpoint = `https://${chainId}.rpc.hypersync.xyz`;
    }

    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const id = ++this.requestId;

    try {
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          params,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`HyperRPC ${method} failed: ${res.status} ${res.statusText}`);
      }

      const json = (await res.json()) as { result?: T; error?: { message: string } };

      if (json.error) {
        throw new Error(`HyperRPC error: ${json.error.message}`);
      }

      return json.result as T;
    } finally {
      clearTimeout(timer);
    }
  }

  // === The 10 prioritized methods ===

  async chainId(): Promise<number> {
    const hex = await this.rpc<`0x${string}`>("eth_chainId", []);
    return parseInt(hex, 16);
  }

  async blockNumber(): Promise<bigint> {
    const hex = await this.rpc<`0x${string}`>("eth_blockNumber", []);
    return BigInt(hex);
  }

  async getBlockByNumber(block: bigint | "latest" | "pending", includeTx = false): Promise<HyperRpcBlock | null> {
    const tag = typeof block === "bigint" ? `0x${block.toString(16)}` : block;
    return this.rpc("eth_getBlockByNumber", [tag, includeTx]);
  }

  async getBlockByHash(hash: `0x${string}`, includeTx = false): Promise<HyperRpcBlock | null> {
    return this.rpc("eth_getBlockByHash", [hash, includeTx]);
  }

  async getBlockReceipts(block: bigint | `0x${string}`): Promise<HyperRpcReceipt[] | null> {
    const tag = typeof block === "bigint" ? `0x${block.toString(16)}` : block;
    return this.rpc("eth_getBlockReceipts", [tag]);
  }

  async getTransactionByHash(hash: `0x${string}`): Promise<HyperRpcTransaction | null> {
    return this.rpc("eth_getTransactionByHash", [hash]);
  }

  async getTransactionByBlockHashAndIndex(blockHash: `0x${string}`, index: number | bigint): Promise<HyperRpcTransaction | null> {
    const idx = typeof index === "number" ? `0x${index.toString(16)}` : `0x${index.toString(16)}`;
    return this.rpc("eth_getTransactionByBlockHashAndIndex", [blockHash, idx]);
  }

  async getTransactionByBlockNumberAndIndex(block: bigint | `0x${string}`, index: number | bigint): Promise<HyperRpcTransaction | null> {
    const tag = typeof block === "bigint" ? `0x${block.toString(16)}` : block;
    const idx = typeof index === "number" ? `0x${index.toString(16)}` : `0x${index.toString(16)}`;
    return this.rpc("eth_getTransactionByBlockNumberAndIndex", [tag, idx]);
  }

  async getTransactionReceipt(hash: `0x${string}`): Promise<HyperRpcReceipt | null> {
    return this.rpc("eth_getTransactionReceipt", [hash]);
  }

  async getLogs(params: {
    fromBlock?: bigint | `0x${string}`;
    toBlock?: bigint | `0x${string}`;
    address?: `0x${string}` | `0x${string}`[];
    topics?: (string | string[] | null)[];
  }): Promise<HyperRpcLog[]> {
    const rpcParams: Record<string, unknown> = {};

    if (params.fromBlock !== undefined) {
      rpcParams.fromBlock = typeof params.fromBlock === "bigint" ? `0x${params.fromBlock.toString(16)}` : params.fromBlock;
    }
    if (params.toBlock !== undefined) {
      rpcParams.toBlock = typeof params.toBlock === "bigint" ? `0x${params.toBlock.toString(16)}` : params.toBlock;
    }
    if (params.address) rpcParams.address = params.address;
    if (params.topics) rpcParams.topics = params.topics;

    return this.rpc("eth_getLogs", [rpcParams]);
  }
}

// Factory helper used by RpcManager / boot
export function createHyperRpcClient(config: HyperRpcConfig): HyperRpcClient | undefined {
  const hasToken = !!config.apiToken?.trim();
  const hasCustomUrl = !!config.url;

  if (!hasToken && !hasCustomUrl) return undefined;

  return new HyperRpcClient(config);
}
