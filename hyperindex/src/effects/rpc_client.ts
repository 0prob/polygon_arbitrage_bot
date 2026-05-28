import { createPublicClient, http, type PublicClient } from "viem";
import { polygon } from "viem/chains";

/**
 * Centralized RPC client for all effects.
 *
 * Optimized for free / generous free-tier providers on Polygon.
 *
 * Recommended free-tier providers (best batching + multicall performance):
 *   1. Alchemy (sign up for free tier - 10M+ compute units/mo, excellent batching)
 *   2. LlamaRPC (https://polygon.llamarpc.com) - completely free, no key, very reliable
 *   3. PublicNode (https://polygon-bor-rpc.publicnode.com) - free, no key
 *
 * Set POLYGON_RPC_URL in your environment to override.
 * For best results with free tiers, prefer providers with strong multicall support.
 */

const DEFAULT_FREE_TIER_RPC =
  process.env.POLYGON_RPC_URL ||
  "https://polygon.llamarpc.com"; // Excellent free public endpoint

const BATCH_SIZE = 64;           // Conservative for most free tiers
const MULTICALL_BATCH_SIZE = 64;
const MULTICALL_WAIT_MS = 20;

export const publicClient: PublicClient = createPublicClient({
  chain: polygon,
  transport: http(DEFAULT_FREE_TIER_RPC, {
    batch: {
      batchSize: BATCH_SIZE,
    },
    timeout: 15_000,
    retryCount: 2,
    retryDelay: 150,
  }),
  batch: {
    multicall: {
      wait: MULTICALL_WAIT_MS,
      batchSize: MULTICALL_BATCH_SIZE,
    },
  },
});

// Re-export for convenience in effects
export { polygon };
