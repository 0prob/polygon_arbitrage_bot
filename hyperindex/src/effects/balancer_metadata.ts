import { createEffect, S } from "envio";
import { parseAbi } from "viem";
import { publicClient } from "./rpc_client";

const BALANCER_ABI = parseAbi([
  "function getPoolId() view returns (bytes32)",
  "function getSwapFeePercentage() view returns (uint256)",
  "function getNormalizedWeights() view returns (uint256[])",
  "function getAmplificationParameter() view returns (uint256 value, bool isUpdating, uint256 precision)",
  "function getScalingFactors() view returns (uint256[])",
]);

const VAULT_ABI = parseAbi([
  "function getPoolTokens(bytes32 poolId) view returns (address[], uint256[], uint256)",
]);

const BALANCER_VAULT = "0xba12222222228d8ba445958a75a0704d566bf2c8" as const;

/**
 * Balancer pool metadata via batched RPC (free-tier friendly).
 * Rate limit kept conservative because Balancer calls are heavier (multiple reads per pool).
 */
export const fetchBalancerMetadata = createEffect(
  {
    name: "fetchBalancerMetadata",
    input: {
      pool: S.string,
      poolId: S.optional(S.string),
      blockNumber: S.optional(S.bigint),
    },
    output: {
      poolId: S.string,
      balances: S.array(S.bigint),
      tokens: S.array(S.string),
      lastChangeBlock: S.bigint,
      swapFee: S.bigint,
      weights: S.optional(S.array(S.bigint)),
      amp: S.optional(S.bigint),
      scalingFactors: S.optional(S.array(S.bigint)),
    },
    rateLimit: { calls: 8, per: "second" }, // Heavy calls — be nice to free tiers
    cache: true,
  },
  async ({ input, context }) => {
    try {
      const pool = input.pool as `0x${string}`;
      const opts = input.blockNumber ? { blockNumber: input.blockNumber } : undefined;

      const poolId =
        (input.poolId as `0x${string}`) ||
        (await publicClient.readContract({
          address: pool,
          abi: BALANCER_ABI,
          functionName: "getPoolId",
          ...opts,
        }));

      const [poolTokensResult, swapFee, weights, ampResult, scalingFactors] = await Promise.all([
        publicClient.readContract({
          address: BALANCER_VAULT,
          abi: VAULT_ABI,
          functionName: "getPoolTokens",
          args: [poolId],
          ...opts,
        }),
        publicClient
          .readContract({
            address: pool,
            abi: BALANCER_ABI,
            functionName: "getSwapFeePercentage",
            ...opts,
          })
          .catch(() => 0n),
        publicClient
          .readContract({
            address: pool,
            abi: BALANCER_ABI,
            functionName: "getNormalizedWeights",
            ...opts,
          })
          .catch(() => undefined),
        publicClient
          .readContract({
            address: pool,
            abi: BALANCER_ABI,
            functionName: "getAmplificationParameter",
            ...opts,
          })
          .catch(() => undefined),
        publicClient
          .readContract({
            address: pool,
            abi: BALANCER_ABI,
            functionName: "getScalingFactors",
            ...opts,
          })
          .catch(() => undefined),
      ]);

      const [tokens, balances, lastChangeBlock] = poolTokensResult as [string[], bigint[], bigint];

      if (context.log) {
        context.log.info("Fetched Balancer pool metadata", { pool: input.pool });
      }

      return {
        poolId: poolId as string,
        tokens: (tokens as string[]).map((t) => t.toLowerCase()),
        balances: (balances as bigint[]).map((b) => BigInt(b)),
        lastChangeBlock: BigInt(lastChangeBlock as bigint),
        swapFee: BigInt(swapFee as bigint),
        weights: weights as bigint[] | undefined,
        amp: ampResult ? (ampResult as [bigint, boolean, bigint])[0] : undefined,
        scalingFactors: scalingFactors as bigint[] | undefined,
      };
    } catch (err) {
      if (context.log) {
        context.log.warn("Failed to fetch Balancer metadata", {
          pool: input.pool,
          error: String(err),
        });
      }
      context.cache = false;
      return { poolId: "", tokens: [], balances: [], lastChangeBlock: 0n, swapFee: 0n };
    }
  },
);
