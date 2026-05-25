import { createEffect, S } from "envio";
import { createPublicClient, http, parseAbi } from "viem";
import { polygon } from "viem/chains";

const client = createPublicClient({
  chain: polygon,
  transport: http(process.env.POLYGON_RPC_URL!, {
    batch: { batchSize: 100 },
    timeout: 10_000,
  }),
  batch: {
    multicall: { wait: 16, batchSize: 100 },
  },
});

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

export const fetchBalancerMetadata = createEffect(
  {
    name: "fetchBalancerMetadata",
    input: { pool: S.string, poolId: S.optional(S.string) },
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
    rateLimit: { calls: 100, per: "second" },
    cache: true,
  },
  async ({ input }) => {
    try {
      const pool = input.pool as `0x${string}`;
      const poolId = (input.poolId as `0x${string}`) || 
        await client.readContract({ address: pool, abi: BALANCER_ABI, functionName: "getPoolId" });

      const vault = "0xba12222222228d8ba445958a75a0704d566bf2c8" as const;
      const [poolTokensResult, swapFee, weights, ampResult, scalingFactors] = await Promise.all([
        client.readContract({ address: vault, abi: VAULT_ABI, functionName: "getPoolTokens", args: [poolId] }),
        client.readContract({ address: pool, abi: BALANCER_ABI, functionName: "getSwapFeePercentage" }).catch(() => 0n),
        client.readContract({ address: pool, abi: BALANCER_ABI, functionName: "getNormalizedWeights" }).catch(() => undefined),
        client.readContract({ address: pool, abi: BALANCER_ABI, functionName: "getAmplificationParameter" }).catch(() => undefined),
        client.readContract({ address: pool, abi: BALANCER_ABI, functionName: "getScalingFactors" }).catch(() => undefined),
      ]);

      const [tokens, balances, lastChangeBlock] = poolTokensResult as [string[], bigint[], bigint];
      
      return {
        poolId: poolId as string,
        tokens: (tokens as string[]).map(t => t.toLowerCase()),
        balances: (balances as bigint[]).map((b) => BigInt(b)),
        lastChangeBlock: BigInt(lastChangeBlock as bigint),
        swapFee: BigInt(swapFee as bigint),
        weights: weights as bigint[] | undefined,
        amp: ampResult ? (ampResult as [bigint, boolean, bigint])[0] : undefined,
        scalingFactors: scalingFactors as bigint[] | undefined,
      };
    } catch {
      return { poolId: "", tokens: [], balances: [], lastChangeBlock: 0n, swapFee: 0n };
    }
  },
);
