import { createEffect, S } from "envio";
import { parseAbi } from "viem";
import { publicClient } from "./rpc_client";

const DODO_ABI = parseAbi([
  "function _I_() view returns (uint256)",
  "function _K_() view returns (uint256)",
  "function _BASE_RESERVE_() view returns (uint256)",
  "function _QUOTE_RESERVE_() view returns (uint256)",
  "function _BASE_TARGET_() view returns (uint256)",
  "function _QUOTE_TARGET_() view returns (uint256)",
  "function _R_STATUS_() view returns (uint8)",
  "function _LP_FEE_RATE_() view returns (uint256)",
  "function _MT_FEE_RATE_() view returns (uint256)",
]);

/**
 * DODO V2 pool metadata. Many small pools, each requiring ~10 historical reads.
 * Tuned for pay-as-you-go Alchemy + viem batching.
 */
export const fetchDodoMetadata = createEffect(
  {
    name: "fetchDodoMetadata",
    input: {
      pool: S.string,
      blockNumber: S.optional(S.bigint),
    },
    output: {
      i: S.bigint,
      k: S.bigint,
      baseReserve: S.bigint,
      quoteReserve: S.bigint,
      baseTarget: S.bigint,
      quoteTarget: S.bigint,
      rStatus: S.number,
      fee: S.bigint,
      lpFeeRate: S.bigint,
      mtFeeRate: S.bigint,
    },
    rateLimit: { calls: 150, per: "second" }, // Pay-as-you-go Alchemy. ~10 reads per effect; batching in the shared client keeps HTTP volume reasonable.
    cache: true,
  },
  async ({ input, context }) => {
    try {
      const address = input.pool as `0x${string}`;
      const opts = input.blockNumber ? { blockNumber: input.blockNumber } : undefined;

      const [i, k, b, q, b0, q0, r, lp, mt] = await Promise.all([
        publicClient.readContract({ address, abi: DODO_ABI, functionName: "_I_", ...opts }),
        publicClient.readContract({ address, abi: DODO_ABI, functionName: "_K_", ...opts }),
        publicClient.readContract({ address, abi: DODO_ABI, functionName: "_BASE_RESERVE_", ...opts }),
        publicClient.readContract({ address, abi: DODO_ABI, functionName: "_QUOTE_RESERVE_", ...opts }),
        publicClient.readContract({ address, abi: DODO_ABI, functionName: "_BASE_TARGET_", ...opts }),
        publicClient.readContract({ address, abi: DODO_ABI, functionName: "_QUOTE_TARGET_", ...opts }),
        publicClient.readContract({ address, abi: DODO_ABI, functionName: "_R_STATUS_", ...opts }),
        publicClient.readContract({ address, abi: DODO_ABI, functionName: "_LP_FEE_RATE_", ...opts }),
        publicClient.readContract({ address, abi: DODO_ABI, functionName: "_MT_FEE_RATE_", ...opts }),
      ]);

      if (context.log) {
        context.log.info("Fetched DODO pool metadata", { pool: input.pool });
      }

      return {
        i,
        k,
        baseReserve: b,
        quoteReserve: q,
        baseTarget: b0,
        quoteTarget: q0,
        rStatus: Number(r),
        fee: (lp as bigint) + (mt as bigint),
        lpFeeRate: lp as bigint,
        mtFeeRate: mt as bigint,
      };
    } catch (err) {
      const errStr = String(err);
      const isQuota = errStr.includes("Monthly") || errStr.includes("capacity") || errStr.includes("quota") || errStr.includes("rate");

      if (context.log) {
        if (isQuota) {
          context.log.warn(
            "Alchemy quota / monthly capacity exceeded while fetching DODO metadata. Add more RPC providers to POLYGON_RPC_URLS.",
          );
        } else {
          context.log.warn("Failed to fetch DODO metadata", {
            pool: input.pool,
            error: errStr,
          });
        }
      }
      context.cache = false;
      return {
        i: 0n,
        k: 0n,
        baseReserve: 0n,
        quoteReserve: 0n,
        baseTarget: 0n,
        quoteTarget: 0n,
        rStatus: 0,
        fee: 0n,
        lpFeeRate: 0n,
        mtFeeRate: 0n,
      };
    }
  },
);
