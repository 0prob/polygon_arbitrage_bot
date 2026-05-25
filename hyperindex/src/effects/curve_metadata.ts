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
  "function rates(uint256 i) view returns (uint256)",
]);

export const fetchCurveMetadata = createEffect(
  {
    name: "fetchCurveMetadata",
    input: { pool: S.string, nCoins: S.number },
    output: { A: S.bigint, fee: S.bigint, balances: S.array(S.bigint), coins: S.array(S.string), rates: S.array(S.bigint) },
    rateLimit: { calls: 100, per: "second" },
    cache: true,
  },
  async ({ input }) => {
    try {
      const pool = input.pool as `0x${string}`;
      const [A, fee, ...all] = await Promise.all([
        client.readContract({ address: pool, abi: CURVE_ABI, functionName: "A" }).catch(() => 0n),
        client.readContract({ address: pool, abi: CURVE_ABI, functionName: "fee" }).catch(() => 0n),
        ...Array.from({ length: input.nCoins * 3 }, (_, i) => {
          let fn: "balances" | "coins" | "rates";
          let arg: bigint;
          if (i < input.nCoins) {
            fn = "balances";
            arg = BigInt(i);
          } else if (i < input.nCoins * 2) {
            fn = "coins";
            arg = BigInt(i - input.nCoins);
          } else {
            fn = "rates";
            arg = BigInt(i - input.nCoins * 2);
          }
          return client.readContract({ address: pool, abi: CURVE_ABI, functionName: fn, args: [arg] }).catch(() => 10n ** 18n);
        }),
      ]);

      const balances: bigint[] = [];
      const coins: string[] = [];
      const rates: bigint[] = [];
      for (let i = 0; i < input.nCoins; i++) {
        balances.push(BigInt(all[i] as bigint));
        coins.push((all[i + input.nCoins] as string).toLowerCase());
        rates.push(BigInt(all[i + input.nCoins * 2] as bigint));
      }

      return { A: A as bigint, fee: fee as bigint, balances, coins, rates };
    } catch {
      return { A: 100n, fee: 0n, balances: [], coins: [], rates: [] };
    }
  },
);
