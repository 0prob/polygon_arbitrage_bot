// (unchanged header kept for context, no changes needed)
import { toHexTag, handleRpcError, RpcError } from "./utils";
export interface HyperRpcConfig {
  url?: string;
  apiToken?: string;
  timeoutMs?: number;
  // Optional preset chainId; not required for client operation.
  chainId?: number;
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
  private readonly token: string | undefined;
  private requestId = 0;
  // Simple in‑memory caches for static RPC calls
  private _chainIdCache: { value?: number; expiry?: number } = {};
  private _blockNumberCache: { value?: bigint; expiry?: number } = {};
  // Cache TTL in milliseconds (e.g., 100ms instead of 5s for an arbitrage bot)
  private static readonly CACHE_TTL = 100;

  constructor(config: HyperRpcConfig = {}) {
    this.token = config.apiToken?.trim();

    if (config.url) {
      this.endpoint = config.url;
    } else {
      throw new Error("HyperRpcClient requires a URL");
    }

    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const id = ++this.requestId;

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    try {
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          params,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new RpcError(`HyperRPC ${method} failed: ${res.status} ${res.statusText}`);
      }

      const json = (await res.json()) as { result?: T; error?: { message: string } };

      if (json.error) {
        throw new RpcError(`HyperRPC error: ${json.error.message}`);
      }

      return json.result as T;
    } catch (err) {
      // Standardize error handling
      handleRpcError(err, `rpc ${method}`);
    } finally {
      clearTimeout(timer);
    }
  }

  // === The 10 prioritized methods ===

  async chainId(): Promise<number> {
    // Use cache if recent
    const now = Date.now();
    if (this._chainIdCache.value !== undefined && this._chainIdCache.expiry! > now) {
      return this._chainIdCache.value;
    }
    const hex = await this.rpc<`0x${string}`>("eth_chainId", []);
    const id = parseInt(hex, 16);
    this._chainIdCache = { value: id, expiry: now + HyperRpcClient.CACHE_TTL };
    return id;
  }

  async blockNumber(): Promise<bigint> {
    const now = Date.now();
    if (this._blockNumberCache.value !== undefined && this._blockNumberCache.expiry! > now) {
      return this._blockNumberCache.value;
    }
    const hex = await this.rpc<`0x${string}`>("eth_blockNumber", []);
    const bn = BigInt(hex);
    this._blockNumberCache = { value: bn, expiry: now + HyperRpcClient.CACHE_TTL };
    return bn;
  }

  async getBlockByNumber(block: bigint | "latest" | "pending", includeTx = false): Promise<HyperRpcBlock | null> {
    const tag = toHexTag(block);
    return this.rpc("eth_getBlockByNumber", [tag, includeTx]);
  }

  async getBlockByHash(hash: `0x${string}`, includeTx = false): Promise<HyperRpcBlock | null> {
    return this.rpc("eth_getBlockByHash", [hash, includeTx]);
  }

  async getBlockReceipts(block: bigint | `0x${string}`): Promise<HyperRpcReceipt[] | null> {
    const tag = toHexTag(block);
    return this.rpc("eth_getBlockReceipts", [tag]);
  }

  async getTransactionByHash(hash: `0x${string}`): Promise<HyperRpcTransaction | null> {
    return this.rpc("eth_getTransactionByHash", [hash]);
  }

  async getTransactionByBlockHashAndIndex(blockHash: `0x${string}`, index: number | bigint): Promise<HyperRpcTransaction | null> {
    const idx = toHexTag(index);
    return this.rpc("eth_getTransactionByBlockHashAndIndex", [blockHash, idx]);
  }

  async getTransactionByBlockNumberAndIndex(block: bigint | `0x${string}`, index: number | bigint): Promise<HyperRpcTransaction | null> {
    const tag = toHexTag(block);
    const idx = toHexTag(index);
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
      rpcParams.fromBlock = toHexTag(params.fromBlock);
    }
    if (params.toBlock !== undefined) {
      rpcParams.toBlock = toHexTag(params.toBlock);
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
