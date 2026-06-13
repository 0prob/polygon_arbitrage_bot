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
    process.env.ENVIO_POLYGON_RPC_URLS ||
    process.env.ENVIO_POLYGON_RPC_URL ||
    process.env.POLYGON_RPC_URLS ||
    process.env.POLYGON_RPC_URL ||
    "";
  if (raw) {
    const list = raw
      .split(/[,;\s]+/)
      .map((u) => u.trim())
      .filter((u) => u.length > 0);
    if (list.length > 0) return list;
  }

  // Public fallbacks — only used when no ENVIO_POLYGON_RPC_URLS is configured.
  // These are rate-limited and slow; add paid endpoints to ENVIO_POLYGON_RPC_URLS in .env.
  return ["https://polygon.drpc.org", "https://polygon-mainnet.public.blastapi.io", "https://polygon.api.onfinality.io/public"];
}

let publicClientInstance: PublicClient | undefined;

function buildPublicClient(): PublicClient {
  const rpcUrls = getRpcUrls();
  if (process.env.VITEST !== "true") {
    console.log("[rpc_client] Initializing with RPC URLs:", rpcUrls);
  }

  const transports: HttpTransport[] = rpcUrls.map((url) =>
    http(url, {
      batch: {
        batchSize: 8, // Safe standard JSON-RPC batching size
        wait: 20,
      },
      timeout: 15_000, // Slightly raised for catchup bursts
      retryCount: 3,
      retryDelay: 500,
    }),
  );

  const transport = transports.length > 1 ? fallback(transports, { rank: true }) : transports[0];

  return createPublicClient({
    chain: polygon,
    transport,
  });
}

/** Lazy client — avoids RPC setup during Vitest handler runs that only hit the static registry. */
export const publicClient: PublicClient = new Proxy({} as PublicClient, {
  get(_target, prop, receiver) {
    if (!publicClientInstance) {
      publicClientInstance = buildPublicClient();
    }
    const value = Reflect.get(publicClientInstance, prop, receiver);
    return typeof value === "function" ? value.bind(publicClientInstance) : value;
  },
});

// Re-export for convenience in effects
export { polygon };
