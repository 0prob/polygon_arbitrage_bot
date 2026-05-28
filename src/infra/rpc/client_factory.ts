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
import { parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getChain } from "./chains.ts";
import { polygon } from "viem/chains";

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

const ARCHIVE_TEST_TOKEN = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" as const; // USDC on Polygon
const ARCHIVE_TEST_BLOCK = 10_000_000n;
const DECIMALS_TEST_ABI = parseAbi(["function decimals() view returns (uint8)"]);

/**
 * Test RPC URLs for support of historical archival eth_call (used by HyperIndex
 * effects for token metadata etc at PairCreated block heights). Removes any that
 * fail the call (non-archival, down, or incompatible free RPCs).
 */
export async function filterArchivalRpcUrls(urls: readonly string[]): Promise<string[]> {
  if (!urls || urls.length === 0) return [];
  const probeTimeoutMs = 7000;

  const checks = urls.map(async (url) => {
    try {
      const transport = http(url, {
        timeout: probeTimeoutMs,
        retryCount: 0,
      });
      const client = createPublicClient({ chain: polygon, transport });
      const result = await client.readContract({
        address: ARCHIVE_TEST_TOKEN,
        abi: DECIMALS_TEST_ABI,
        functionName: "decimals",
        blockNumber: ARCHIVE_TEST_BLOCK,
      });
      return Number(result) === 6 ? url : null;
    } catch {
      return null;
    }
  });

  const settled = await Promise.allSettled(checks);
  return settled.map((s) => (s.status === "fulfilled" ? s.value : null)).filter((u): u is string => !!u);
}
