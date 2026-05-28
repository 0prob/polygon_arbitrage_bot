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
 * Fetches token decimals with a fast free-tier friendly strategy:
 *
 * 1. Static registry (fastest — 200+ common Polygon tokens, 0 RPC)
 * 2. (Future) CoinGecko free API layer (optional fast path)
 * 3. Batched RPC + multicall via the centralized client (last resort)
 *
 * This effect is heavily cached (`cache: true`) because decimals are immutable.
 * Recommended free RPCs: Alchemy (free tier) > LlamaRPC > PublicNode.
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
    rateLimit: { calls: 20, per: "second" }, // Conservative for free tiers
    cache: true, // Critical for performance on restarts / re-runs
  },
  async ({ input, context }) => {
    const addr = input.address.toLowerCase();

    // Layer 1: Static registry (best possible performance)
    const cached = STATIC_TOKEN_DECIMALS[addr];
    if (cached !== undefined) {
      return { address: input.address, decimals: cached };
    }

    // Layer 2: Future hybrid — CoinGecko free API (can be added here easily)
    // For now we go straight to reliable batched RPC (still very fast with good provider)

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
      if (context.log) {
        context.log.warn(`Failed to fetch decimals for token — defaulting to 18`, {
          token: input.address,
          error: String(err),
        });
      }
      // Do not cache obviously bad results forever
      context.cache = false;
      return { address: input.address, decimals: 18 };
    }
  },
);
