import { createPublicClient, http, fallback, type PublicClient, type HttpTransport } from "viem";
import { polygon } from "viem/chains";
import { getRpmTarget, isLowQuota, isVeryLowQuota } from "../utils/pacing";

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

const rpm = getRpmTarget();
const low = isLowQuota();
const veryLow = isVeryLowQuota();

// Dynamic batching tuned to the overall quota (HYPERSYNC_RPM_TARGET).
// When the free-tier HyperSync budget is tight we reduce RPC burstiness from effects
// so the whole system (HyperSync fetches + metadata effects) stays smoother.
const BATCH_SIZE = veryLow ? 32 : low ? 64 : 128;
const MULTICALL_BATCH_SIZE = veryLow ? 32 : low ? 64 : 128;
const MULTICALL_WAIT_MS = veryLow ? 80 : low ? 40 : 10;

const rpcUrls = getRpcUrls();

const transports: HttpTransport[] = rpcUrls.map((url) =>
  http(url, {
    batch: { batchSize: BATCH_SIZE },
    timeout: 4_000, // Reduced from 10s: fail fast for fetchTokenMeta — default-18 is cheap, 15s hangs are not
    retryCount: 1, // Reduced from 3: one retry is enough; repeated failures mean the endpoint is down
    retryDelay: 150,
    fetchOptions: {
      headers: {
        Connection: "keep-alive",
        "Keep-Alive": "timeout=60, max=1000",
      },
    },
  }),
);

const transport = transports.length > 1 ? fallback(transports, { rank: false }) : transports[0];

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
