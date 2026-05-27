import {
  createPublicClient,
  createWalletClient,
  http,
  webSocket,
  fallback,
  type PublicClient,
  type WalletClient,
  type HttpTransport,
  type WebSocketTransport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getChain } from "./chains.ts";

export interface ClientFactoryOptions {
  chainId?: number;
  batchSize?: number;
  batchWaitMs?: number;
  timeoutMs?: number;
  webSocketUrl?: string;
}

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_BATCH_WAIT_MS = 16;
const DEFAULT_TIMEOUT_MS = 10_000;

function createOptimizedTransport(url: string, opts?: ClientFactoryOptions): HttpTransport {
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

function createWebSocketTransport(url: string): WebSocketTransport {
  return webSocket(url, {
    keepAlive: { interval: 10_000 },
  });
}

export function createReadClient(urls: string[], opts?: ClientFactoryOptions): PublicClient {
  const chainId = opts?.chainId ?? 137;
  const chain = getChain(chainId);

  const transports = urls.map((url) => createOptimizedTransport(url, opts));
  const transport = opts?.webSocketUrl
    ? fallback([createWebSocketTransport(opts.webSocketUrl), ...transports], { rank: true })
    : fallback(transports, { rank: true });

  return createPublicClient({
    chain,
    transport,
    batch: {
      multicall: {
        wait: opts?.batchWaitMs ?? DEFAULT_BATCH_WAIT_MS,
        batchSize: opts?.batchSize ?? DEFAULT_BATCH_SIZE,
      },
    },
  });
}

export function createExecutionClient(rpcUrl: string, privateKey?: string, chainId: number = 137): WalletClient {
  const chain = getChain(chainId);
  const pk = privateKey ? (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) : undefined;
  const account = pk ? privateKeyToAccount(pk as `0x${string}`) : undefined;

  return createWalletClient({
    ...(account ? { account } : {}),
    chain,
    transport: createOptimizedTransport(rpcUrl, { timeoutMs: 15_000, batchSize: 50 }), // Higher timeout for submission
  });
}

