import { createPublicClient, http, fallback, type PublicClient, type HttpTransport } from "viem";
import { polygon } from "viem/chains";

/**
 * Centralized RPC client for all effects.
 *
 * Supports comma-separated POLYGON_RPC_URLS (or POLYGON_RPC_URL) from .env.
 * Endpoints from .env are used (with internal fallback) before falling back to
 * a default free public RPC. Non-supporting endpoints (e.g. lacking archival
 * historical eth_call for decimals() etc) should be removed upstream before
 * being passed here.
 *
 * Recommended (prioritize ones with good archival + batch support):
 *   1. Your paid Alchemy/QuickNode/etc (set in main .env as POLYGON_RPC_URLS)
 *   2. LlamaRPC, PublicNode, etc (free public last resort)
 */

function getRpcUrls(): string[] {
  const raw =
    process.env.POLYGON_RPC_URLS ||
    process.env.POLYGON_RPC_URL ||
    process.env.POLYGON_RPC ||
    "";
  if (raw) {
    const list = raw
      .split(/[,;\s]+/)
      .map((u) => u.trim())
      .filter((u) => u.length > 0);
    if (list.length > 0) return list;
  }
  // Only after no .env endpoints: default free public
  return ["https://polygon.llamarpc.com"];
}

const BATCH_SIZE = 64;
const MULTICALL_BATCH_SIZE = 64;
const MULTICALL_WAIT_MS = 20;

const rpcUrls = getRpcUrls();

const transports: HttpTransport[] = rpcUrls.map((url) =>
  http(url, {
    batch: { batchSize: BATCH_SIZE },
    timeout: 15_000,
    retryCount: 2,
    retryDelay: 150,
  })
);

const transport = transports.length > 1
  ? fallback(transports, { rank: true })
  : transports[0];

export const publicClient: PublicClient = createPublicClient({
  chain: polygon,
  transport,
  batch: {
    multicall: {
      wait: MULTICALL_WAIT_MS,
      batchSize: MULTICALL_BATCH_SIZE,
    },
  },
});

// Re-export for convenience in effects
export { polygon };
