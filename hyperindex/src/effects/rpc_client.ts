import { createPublicClient, http, fallback, type PublicClient, type HttpTransport } from "viem";
import { polygon } from "viem/chains";

/**
 * Centralized RPC client for all effects (token decimals, Curve/Balancer/DODO metadata, etc.).
 *
 * Supports comma-separated POLYGON_RPC_URLS (preferred) or POLYGON_RPC_URL from .env.
 * .env endpoints (after archival probe filtering upstream) are used with viem fallback().
 * Only falls back to public RPCs (no embedded keys) when nothing usable was provided.
 *
 * The effect rateLimits (in the metadata effects) are now raised for pay-as-you-go
 * Alchemy. The batch + multicall settings here keep the actual HTTP request rate
 * much lower than the effect invocation rate.
 *
 * Recommended:
 *   1. Alchemy pay-as-you-go (best for historical eth_call volume + multicall)
 *   2. Other paid archival providers
 *   3. Free public as last resort only
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
  // Public fallbacks only (no paid/demo keys). For production use POLYGON_RPC_URLS (comma sep) with archival providers.
  // HyperIndex effects will probe/filter for archive support upstream in the bot boot path.
  return [
    "https://polygon-rpc.com",
    "https://polygon-mainnet.public.blastapi.io",
    "https://1rpc.io/matic",
    "https://rpc.ankr.com/polygon",
    "https://polygon.llamarpc.com"
  ];
}

const BATCH_SIZE = 128;             // Higher with pay-as-you-go Alchemy
const MULTICALL_BATCH_SIZE = 128;
const MULTICALL_WAIT_MS = 10;         // Slightly more aggressive batching

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
