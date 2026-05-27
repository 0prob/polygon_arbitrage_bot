import {
  createPublicClient,
  createWalletClient,
  http,
  fallback,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { RpcConfig } from "../config/schema.ts";
import { getChain } from "../infra/rpc/chains.ts";
import { FastLaneSubmitter } from "../infra/rpc/fastlane.ts";
import { WebSocketSubscriber } from "../infra/rpc/websocket_subscriber.ts";
import { ReorgDetector } from "../infra/resilience/reorg_detector.ts";

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_BATCH_WAIT_MS = 16;
const DEFAULT_TIMEOUT_MS = 10_000;

function httpTransport(url: string, opts?: { batchSize?: number; timeoutMs?: number }) {
  return http(url, {
    batch: { batchSize: opts?.batchSize ?? DEFAULT_BATCH_SIZE },
    timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    fetchOptions: {
      headers: {
        Connection: "keep-alive",
        "Keep-Alive": "timeout=60, max=1000",
      },
    },
  });
}

export interface RpcManagerOptions {
  chainId?: number;
}

export class RpcManager {
  public readonly chainId: number;
  private _readClient: PublicClient;
  private _executionClients: WalletClient[] = [];
  private _fastLane: FastLaneSubmitter | undefined;
  private _ws: WebSocketSubscriber | undefined;
  private _reorgDetector: ReorgDetector | undefined;

  constructor(config: RpcConfig, opts?: RpcManagerOptions) {
    this.chainId = opts?.chainId ?? 137;
    const chain = getChain(this.chainId);

    // Read client: fallback across polygonRpcUrls
    const transports = config.polygonRpcUrls.map((url) =>
      httpTransport(url, {
        batchSize: config.batchSize,
        timeoutMs: config.requestTimeoutMs,
      }),
    );
    this._readClient = createPublicClient({
      chain,
      transport: fallback(transports, { rank: true }),
      batch: {
        multicall: {
          wait: config.batchWaitMs ?? DEFAULT_BATCH_WAIT_MS,
          batchSize: config.batchSize ?? DEFAULT_BATCH_SIZE,
        },
      },
    });

    this._reorgDetector = new ReorgDetector(this._readClient, 10);
  }

  /** The read PublicClient (used by existing consumers for backward compat) */
  getReadClient(): PublicClient {
    return this._readClient;
  }

  /** The reorg detector (wraps the read client internally) */
  getReorgDetector(): ReorgDetector {
    return this._reorgDetector!;
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

  // === Execution clients ===
  addExecutionClient(rpcUrl: string, privateKey: string): WalletClient {
    const chain = getChain(this.chainId);
    const pk = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
    const account = privateKeyToAccount(pk as `0x${string}`);
    const client = createWalletClient({
      account,
      chain,
      transport: httpTransport(rpcUrl, { timeoutMs: 15_000, batchSize: 50 }),
    });
    this._executionClients.push(client);
    return client;
  }

  getExecutionClients(): WalletClient[] {
    return this._executionClients;
  }

  // === FastLane ===
  addFastLane(fastLaneConfig: { enabled: boolean; rpcUrl: string; blockNumberWindow: number; timestampWindowS: number }): FastLaneSubmitter | undefined {
    if (!fastLaneConfig.enabled) return undefined;
    const client = createWalletClient({
      account: this._executionClients[0]?.account!,
      chain: getChain(this.chainId),
      transport: http(fastLaneConfig.rpcUrl),
    });
    this._fastLane = new FastLaneSubmitter(
      {
        enabled: fastLaneConfig.enabled,
        rpcUrl: fastLaneConfig.rpcUrl,
        conditional: {
          blockNumberWindow: fastLaneConfig.blockNumberWindow,
          timestampWindowS: fastLaneConfig.timestampWindowS,
        },
      },
      client,
    );
    return this._fastLane;
  }

  getFastLane(): FastLaneSubmitter | undefined {
    return this._fastLane;
  }

  // === WebSocket ===
  addWebSocketSubscriber(url: string, opts?: { reconnectDelayMs?: number; pingIntervalMs?: number }): WebSocketSubscriber {
    this._ws = new WebSocketSubscriber({
      url,
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
