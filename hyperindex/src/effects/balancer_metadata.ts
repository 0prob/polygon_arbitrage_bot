import { createEffect, S } from "envio";
import { createPublicClient, http, parseAbi } from "viem";
import { polygon } from "viem/chains";

const client = createPublicClient({
  chain: polygon,
  transport: http(process.env.POLYGON_RPC_URL!, { batch: true }),
});

const BALANCER_ABI = parseAbi([
  "function getPoolId() view returns (bytes32)",
]);

const VAULT_ABI = parseAbi([
  "function getPoolTokens(bytes32 poolId) view returns (address[], uint256[], uint256)",
]);

export const fetchBalancerMetadata = createEffect(
  {
    name: "fetchBalancerMetadata",
    input: { pool: S.string },
    output: { poolId: S.string, balances: S.array(S.bigint), lastChangeBlock: S.bigint },
    rateLimit: { calls: 10, per: "second" },
    cache: true,
  },
  async ({ input }) => {
    try {
      const pool = input.pool as `0x${string}`;
      const poolId = await client.readContract({ address: pool, abi: BALANCER_ABI, functionName: "getPoolId" });
      const vault = "0xba12222222228d8ba445958a75a0704d566bf2c8" as const;
      const [tokens, balances, lastChangeBlock] = await client.readContract({
        address: vault,
        abi: VAULT_ABI,
        functionName: "getPoolTokens",
        args: [poolId],
      });
      return {
        poolId: poolId as string,
        balances: (balances as bigint[]).map((b) => BigInt(b)),
        lastChangeBlock: BigInt(lastChangeBlock as bigint),
      };
    } catch {
      return { poolId: "", balances: [], lastChangeBlock: 0n };
    }
  },
);
