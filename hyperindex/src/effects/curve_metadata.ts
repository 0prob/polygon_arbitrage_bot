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

const CURVE_ABI = parseAbi([
  "function A() view returns (uint256)",
  "function fee() view returns (uint256)",
  "function balances(uint256 i) view returns (uint256)",
  "function coins(uint256 i) view returns (address)",
]);

export const fetchCurveMetadata = createEffect(
  {
    name: "fetchCurveMetadata",
    input: { pool: S.string, nCoins: S.number },
    output: { A: S.bigint, fee: S.bigint, balances: S.array(S.bigint), coins: S.array(S.string) },
    rateLimit: { calls: 100, per: "second" },
    cache: true,
  },
  async ({ input }) => {
    try {
      const pool = input.pool as `0x${string}`;
      const [A, fee, ...all] = await Promise.all([
        client.readContract({ address: pool, abi: CURVE_ABI, functionName: "A" }).catch(() => 0n),
        client.readContract({ address: pool, abi: CURVE_ABI, functionName: "fee" }).catch(() => 0n),
        ...Array.from({ length: input.nCoins * 2 }, (_, i) => {
          const fn = i < input.nCoins ? "balances" : "coins";
          const arg = i < input.nCoins ? BigInt(i) : BigInt(i - input.nCoins);
          return client.readContract({ address: pool, abi: CURVE_ABI, functionName: fn, args: [arg] });
        }),
      ]);

      const balances: bigint[] = [];
      const coins: string[] = [];
      for (let i = 0; i < input.nCoins; i++) {
        const b = all[i];
        const c = all[i + input.nCoins];
        if (b != null && c != null) {
          balances.push(BigInt(b));
          coins.push((c as string).toLowerCase());
        } else {
          break;
        }
      }

      return { A: A as bigint, fee: fee as bigint, balances, coins };
    } catch {
      return { A: 100n, fee: 0n, balances: [], coins: [] };
    }
  },
);
