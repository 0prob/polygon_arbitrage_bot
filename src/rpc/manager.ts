import { createPublicClient, createWalletClient, http, fallback, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Alchemy, Network, type AlchemySettings } from "alchemy-sdk";
import type { RpcConfig } from "../config/schema.ts";
import { getChain } from "../infra/rpc/chains.ts";
import { WebSocketSubscriber } from "../infra/rpc/websocket_subscriber.ts";
import { ReorgDetector } from "../infra/resilience/reorg_detector.ts";
import { HyperRpcClient, createHyperRpcClient } from "../infra/rpc/hyperrpc.ts";
import { HyperSyncService, createHyperSyncService } from "../infra/hypersync/hypersync_service.ts";
import { RequestScheduler, RequestPriority } from "../services/rpc/request_scheduler.ts";

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_BATCH_WAIT_MS = 16;
const DEFAULT_TIMEOUT_MS = 10_000;

export interface RpcManagerOptions {
  chainId?: number;
}

export class RpcManager {
  public readonly chainId: number;
  public readonly scheduler: RequestScheduler;
  private _readClient: PublicClient;
  private _executionClients: WalletClient[] = [];
  private _ws: WebSocketSubscriber | undefined;
  private _reorgDetector: ReorgDetector | undefined;
  private _hyperRpc: HyperRpcClient | undefined;
  private _hyperSync: HyperSyncService | undefined;
  private _alchemy: Alchemy | undefined;
  private _privateRelayClients: WalletClient[] = [];
  private _stateClient: PublicClient | undefined;

  constructor(config: RpcConfig, opts?: RpcManagerOptions) {
    this.chainId = opts?.chainId ?? 137;
    const chain = getChain(this.chainId);
    this.scheduler = new RequestScheduler(config.chainstackRps ?? 250);

    // Alchemy SDK initialization
    if (config.alchemyApiKey) {
      const settings: AlchemySettings = {
        apiKey: config.alchemyApiKey,
        network: Network.MATIC_MAINNET,
        batchRequests: config.alchemyBatchRequests,
      };
      this._alchemy = new Alchemy(settings);
    }

    // Read client: rate-limited transport to polygonRpcUrls
    // When multiple URLs are configured, use fallback for redundancy
    const transports = config.polygonRpcUrls.map((url) =>
      this.rateLimitedTransport(url, RequestPriority.HIGH, {
        batchSize: config.batchSize,
        timeoutMs: config.requestTimeoutMs,
        alchemyApiKey: config.alchemyApiKey,
      }),
    );
    this._readClient = createPublicClient({
      chain,
      transport: transports.length > 1 ? fallback(transports, { rank: true }) : transports[0],
      batch: {
        multicall: {
          wait: config.batchWaitMs ?? DEFAULT_BATCH_WAIT_MS,
          batchSize: config.batchSize ?? DEFAULT_BATCH_SIZE,
        },
      },
    });

    // Official high-performance HyperSync client (preferred for most new read paths)
    // Gracefully degrades if the native package isn't installed yet.
    // IMPORTANT: Created BEFORE ReorgDetector so it receives the instance.
    if (config.hyperSyncUrl) {
      this._hyperSync = createHyperSyncService({
        url: config.hyperSyncUrl,
        apiToken: config.hyperRpcApiToken,
        timeoutMs: config.requestTimeoutMs,
      });
    }

    // HyperRPC — optional read-only high-performance provider (per 2026 Envio docs).
    // Use for the specific read methods only. Prefer HyperSync client for advanced needs.
    if (config.hyperRpcUrl) {
      this._hyperRpc = createHyperRpcClient({
        url: config.hyperRpcUrl,
        apiToken: config.hyperRpcApiToken,
        timeoutMs: config.requestTimeoutMs,
        chainId: this.chainId,
      });
    }

    // ReorgDetector — created AFTER both HyperSync and HyperRPC so it receives the instances.
    this._reorgDetector = new ReorgDetector(this._readClient, 10, this._hyperRpc, this._hyperSync);
  }

  /** The read PublicClient (used by existing consumers for backward compat) */
  getReadClient(): PublicClient {
    return this._readClient;
  }

  /** The reorg detector (wraps the read client internally) */
  getReorgDetector(): ReorgDetector {
    return this._reorgDetector!;
  }

  addStateClient(url: string, batchSize?: number, batchWaitMs?: number): PublicClient {
    const chain = getChain(this.chainId);
    this._stateClient = createPublicClient({
      chain,
      transport: this.rateLimitedTransport(url, RequestPriority.HIGH, { batchSize }),
      batch: {
        multicall: {
          wait: batchWaitMs,
          batchSize,
        },
      },
    });
    return this._stateClient;
  }

  getStateClient(): PublicClient | undefined {
    return this._stateClient;
  }

  addPrivateRelayClient(url: string, privateKey: string): WalletClient {
    const chain = getChain(this.chainId);
    const pk = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
    const account = privateKeyToAccount(pk as `0x${string}`);
    const client = createWalletClient({
      account,
      chain,
      transport: this.rateLimitedTransport(url, RequestPriority.CRITICAL, { timeoutMs: 15_000, batchSize: 50 }),
    });
    this._privateRelayClients.push(client);
    return client;
  }

  getPrivateRelayClients(): WalletClient[] {
    return this._privateRelayClients;
  }

  /**
   * HyperRPC client — READ-ONLY high-performance provider.
   *
   * Only populated when HYPERRPC_API_TOKEN (or a custom HYPERRPC_URL) is configured.
   * This client must only be used for the 10 read-only methods it supports.
   * Never use it for sending transactions or gas estimation.
   */
  get hyperRpc(): HyperRpcClient | undefined {
    return this._hyperRpc;
  }

  /** Official @envio-dev/hypersync-client wrapper (faster native protocol for blocks/logs/height) */
  get hyperSync(): HyperSyncService | undefined {
    return this._hyperSync;
  }

  /** Alchemy SDK instance (populated when ALCHEMY_API_KEY is configured) */
  get alchemy(): Alchemy | undefined {
    return this._alchemy;
  }

  // === Read operations ===
  get read() {
    return {
      multicall: this._readClient.multicall.bind(this._readClient),
      getBlock: this._readClient.getBlock.bind(this._readClient),
      getTransactionCount: this._readClient.getTransactionCount.bind(this._readClient),
      call: this._readClient.call.bind(this._readClient),
      estimateGas: this._readClient.estimateGas.bind(this._readClient),
      getTransactionReceipt: this._readClient.getTransactionReceipt.bind(this._readClient),
      readContract: this._readClient.readContract.bind(this._readClient),
      estimateMaxPriorityFeePerGas: this._readClient.estimateMaxPriorityFeePerGas.bind(this._readClient),
    };
  }

  /** Create a rate-limited Viem http transport wrapping the scheduler */
  private rateLimitedTransport(
    url: string,
    priority: RequestPriority,
    opts?: { batchSize?: number; timeoutMs?: number; alchemyApiKey?: string },
  ) {
    const headers: Record<string, string> = {
      Connection: "keep-alive",
      "Keep-Alive": "timeout=60, max=1000",
    };

    if (opts?.alchemyApiKey && url.includes("alchemy")) {
      headers["X-Alchemy-Token"] = opts.alchemyApiKey;
    }

    const rawTransport = http(url, {
      batch: opts?.batchSize ? { batchSize: opts.batchSize } : { batchSize: DEFAULT_BATCH_SIZE },
      timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      fetchOptions: {
        headers,
      },
    });

    return (args: Parameters<ReturnType<typeof http>>[0]) => {
      const transport = rawTransport(args);
      const originalRequest = transport.request.bind(transport);
      transport.request = async ({ method, params }: { method: string; params?: unknown }) => {
        return this.scheduler.acquire(priority, () => originalRequest({ method, params }));
      };
      return transport;
    };
  }

  // === Execution clients ===
  addExecutionClient(rpcUrl: string, privateKey: string): WalletClient {
    const chain = getChain(this.chainId);
    const pk = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
    const account = privateKeyToAccount(pk as `0x${string}`);
    const client = createWalletClient({
      account,
      chain,
      transport: this.rateLimitedTransport(rpcUrl, RequestPriority.CRITICAL, { timeoutMs: 15_000, batchSize: 50 }),
    });
    this._executionClients.push(client);
    return client;
  }

  getExecutionClients(): WalletClient[] {
    return this._executionClients;
  }

  // === WebSocket ===
  addWebSocketSubscriber(url: string, opts?: { reconnectDelayMs?: number; pingIntervalMs?: number }): WebSocketSubscriber {
    const finalUrl = url;
    if (this._alchemy && url.includes("alchemy")) {
      // Alchemy resilient WebSocket URL format (can use SDK internally if we refactor WebSocketSubscriber,
      // but for now we'll just ensure the URL is optimized if it's an alchemy one)
      // The current WebSocketSubscriber uses raw ws, we could enhance it later.
    }

    this._ws = new WebSocketSubscriber({
      url: finalUrl,
      maxPendingTxsPerTick: 10,
      reconnectDelayMs: opts?.reconnectDelayMs ?? 5_000,
      pingIntervalMs: opts?.pingIntervalMs ?? 15_000,
    });
    return this._ws;
  }

  getWebSocketSubscriber(): WebSocketSubscriber | undefined {
    return this._ws;
  }
}
