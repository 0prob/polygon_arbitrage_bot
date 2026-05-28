import { createEffect, S } from "envio";
import { parseAbi } from "viem";
import { publicClient } from "./rpc_client";

const CURVE_ABI = parseAbi([
  "function A() view returns (uint256)",
  "function fee() view returns (uint256)",
  "function balances(uint256 i) view returns (uint256)",
  "function coins(uint256 i) view returns (address)",
  "function rates(uint256 i) view returns (uint256)",
]);

/**
 * Curve pool metadata. These calls are relatively heavy (multiple reads per pool).
 * Rate limit is intentionally low to stay within free tier limits.
 */
export const fetchCurveMetadata = createEffect(
  {
    name: "fetchCurveMetadata",
    input: {
      pool: S.string,
      nCoins: S.number,
      blockNumber: S.optional(S.bigint),
    },
    output: {
      A: S.bigint,
      fee: S.bigint,
      balances: S.array(S.bigint),
      coins: S.array(S.string),
      rates: S.array(S.bigint),
    },
    rateLimit: { calls: 6, per: "second" }, // Curve is expensive — protect free RPCs
    cache: true,
  },
  async ({ input, context }) => {
    try {
      const pool = input.pool as `0x${string}`;
      const opts = input.blockNumber ? { blockNumber: input.blockNumber } : undefined;

      const [A, fee, ...all] = await Promise.all([
        publicClient
          .readContract({ address: pool, abi: CURVE_ABI, functionName: "A", ...opts })
          .catch(() => 0n),
        publicClient
          .readContract({ address: pool, abi: CURVE_ABI, functionName: "fee", ...opts })
          .catch(() => 0n),
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
          return publicClient
            .readContract({ address: pool, abi: CURVE_ABI, functionName: fn, args: [arg], ...opts })
            .catch(() => 10n ** 18n);
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

      if (context.log) {
        context.log.info("Fetched Curve pool metadata", { pool: input.pool, nCoins: input.nCoins });
      }

      return { A: A as bigint, fee: fee as bigint, balances, coins, rates };
    } catch (err) {
      if (context.log) {
        context.log.warn("Failed to fetch Curve metadata", {
          pool: input.pool,
          error: String(err),
        });
      }
      context.cache = false;
      return { A: 100n, fee: 0n, balances: [], coins: [], rates: [] };
    }
  },
);
