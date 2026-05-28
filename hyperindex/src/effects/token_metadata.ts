import { createEffect, S } from "envio";
import { parseAbi } from "viem";
import { publicClient } from "./rpc_client";
import { STATIC_TOKEN_DECIMALS } from "./token_registry";

const ERC20_ABI = parseAbi([
  "function decimals() view returns (uint8)",
]);

function safeDecimals(d: number): number {
  if (isNaN(d) || d < 0 || d > 255) return 18;
  return d;
}

/**
 * Fetches token decimals — optimized to avoid RPC as much as possible.
 *
 * Only decimals are pre-generated/sourced here because that is the *only*
 * token metadata the arbitrage engine actually uses (for amount scaling,
 * price impact, profit math, etc.).
 *
 * 1. Large static registry (fastest — 1400+ Polygon tokens, 0 RPC)
 * 2. Batched RPC (last resort, at the historical block when needed)
 *
 * Expand the registry aggressively with: bun run scripts/generate-polygon-tokens.ts
 */
export const fetchTokenMeta = createEffect(
  {
    name: "fetchTokenMeta",
    input: {
      address: S.string,
      // Pass the block number for historical correctness when re-indexing
      blockNumber: S.optional(S.bigint),
    },
    output: { address: S.string, decimals: S.number },
    rateLimit: { calls: 300, per: "second" }, // Pay-as-you-go Alchemy (historical eth_call + multicall). Batching in rpc_client keeps actual HTTP requests much lower.
    cache: true, // Critical for performance on restarts / re-runs
  },
  async ({ input, context }) => {
    const addr = input.address.toLowerCase();

    // Layer 1: Static decimals registry (best possible performance)
    // Strictly limited to decimals — the only token data the arbitrage engine
    // needs for amount math, pricing, and profit calculation.
    const cached = STATIC_TOKEN_DECIMALS[addr];
    if (cached !== undefined) {
      return { address: input.address, decimals: cached };
    }

    try {
      const opts = input.blockNumber
        ? { blockNumber: input.blockNumber }
        : undefined;

      const decimals = await publicClient.readContract({
        address: input.address as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "decimals",
        ...opts,
      });

      const result = { address: input.address, decimals: safeDecimals(Number(decimals)) };

      if (context.log) {
        context.log.info(`Fetched decimals for new token via RPC`, {
          token: input.address,
          decimals: result.decimals,
        });
      }

      return result;
    } catch (err) {
      // Never fail the whole indexing run for one bad token
      const errStr = String(err);
      const isQuota = errStr.includes("Monthly") || errStr.includes("capacity") || errStr.includes("quota") || errStr.includes("rate");

      if (context.log) {
        if (isQuota) {
          context.log.warn(
            `Alchemy quota / monthly capacity exceeded while fetching decimals. ` +
            `Add more providers to POLYGON_RPC_URLS (comma-separated) or lower effect rateLimits temporarily. ` +
            `Defaulting to 18 for this token.`,
            { token: input.address }
          );
        } else {
          context.log.warn(`Failed to fetch decimals for token — defaulting to 18`, {
            token: input.address,
            error: errStr,
          });
        }
      }
      // Do not cache obviously bad results forever
      context.cache = false;
      return { address: input.address, decimals: 18 };
    }
  },
);
