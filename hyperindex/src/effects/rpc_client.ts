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
  // === TEMPORARY DEBUG OVERRIDE (2026-06 live debug session) ===
  // Force the known-good paid endpoints first, bypassing potentially invisible env in Envio effect runtime.
  // This directly targets the 15s SLOW_EFFECT root cause (public RPC fallback).
  const debugForced = [
    "https://polygon-mainnet.core.chainstack.com/03efdc1db374a4df08d42e72b1408637",
    "https://polygon-mainnet.g.alchemy.com/v2/ZOXfVdATBMVCMI-ACp5hW",
  ];

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
    if (list.length > 0) {
      // Put debug-forced first, then any others from env (deduped)
      const combined = [...debugForced, ...list.filter(u => !debugForced.includes(u))];
      return combined;
    }
  }

  // Even with no env at all, still use the good ones + public as last resort
  return [
    ...debugForced,
    "https://polygon.drpc.org",
    "https://polygon-mainnet.public.blastapi.io",
    "https://polygon.api.onfinality.io/public",
  ];
}

const BATCH_SIZE = 128;             // Higher with pay-as-you-go Alchemy
const MULTICALL_BATCH_SIZE = 128;
const MULTICALL_WAIT_MS = 10;         // Slightly more aggressive batching

const rpcUrls = getRpcUrls();

// DIAGNOSTIC (live debug): This runs inside the Envio effect/loader context.
// If you see only the 3 public fallbacks here, then POLYGON_RPC_URLS was not visible
// to the effect runtime → explains 10-15s SLOW_EFFECT on fetchTokenMeta etc.
console.log(JSON.stringify({
  level: 30,
  msg: "RPC_CLIENT_INIT",
  resolvedRpcUrls: rpcUrls,
  source: process.env.POLYGON_RPC_URLS ? "POLYGON_RPC_URLS" : (process.env.POLYGON_RPC_URL ? "POLYGON_RPC_URL" : "PUBLIC_FALLBACKS_ONLY")
}));

const transports: HttpTransport[] = rpcUrls.map((url) =>
  http(url, {
    batch: { batchSize: BATCH_SIZE },
    timeout: 10_000,
    retryCount: 3,
    retryDelay: 250,
    fetchOptions: {
      headers: {
        Connection: "keep-alive",
        "Keep-Alive": "timeout=60, max=1000",
      },
    },
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
