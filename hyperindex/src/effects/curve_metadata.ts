import { createEffect, S } from "envio";
import { createPublicClient, http, parseAbi } from "viem";
import { polygon } from "viem/chains";

const client = createPublicClient({
  chain: polygon,
  transport: http(process.env.POLYGON_RPC_URL!, { batch: true }),
});

const CURVE_ABI = parseAbi([
  "function A() view returns (uint256)",
  "function fee() view returns (uint256)",
  "function balances(uint256 i) view returns (uint256)",
]);

export const fetchCurveMetadata = createEffect(
  {
    name: "fetchCurveMetadata",
    input: { pool: S.string, nCoins: S.number },
    output: { A: S.bigint, fee: S.bigint, balances: S.array(S.bigint) },
    rateLimit: { calls: 10, per: "second" },
    cache: true,
  },
  async ({ input }) => {
    try {
      const pool = input.pool as `0x${string}`;
      const [A, fee] = await Promise.all([
        client.readContract({ address: pool, abi: CURVE_ABI, functionName: "A" }),
        client.readContract({ address: pool, abi: CURVE_ABI, functionName: "fee" }),
      ]);
      const balances: bigint[] = [];
      for (let i = 0; i < input.nCoins; i++) {
        const bal = await client.readContract({ address: pool, abi: CURVE_ABI, functionName: "balances", args: [BigInt(i)] });
        balances.push(bal as bigint);
      }
      return { A: A as bigint, fee: fee as bigint, balances };
    } catch {
      return { A: 100n, fee: 0n, balances: [] };
    }
  },
);
