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

export const fetchDodoMetadata = createEffect(
  {
    name: "fetchDodoMetadata",
    input: { pool: S.string },
    output: {
      i: S.bigint,
      k: S.bigint,
      baseReserve: S.bigint,
      quoteReserve: S.bigint,
      baseTarget: S.bigint,
      quoteTarget: S.bigint,
      rStatus: S.number,
      fee: S.bigint,
    },
    rateLimit: { calls: 100, per: "second" },
    cache: true,
  },
  async ({ input }) => {
    try {
      const address = input.pool as `0x${string}`;
      const [i, k, b, q, b0, q0, r, lp, mt] = await Promise.all([
        client.readContract({ address, abi: DODO_ABI, functionName: "_I_" }),
        client.readContract({ address, abi: DODO_ABI, functionName: "_K_" }),
        client.readContract({ address, abi: DODO_ABI, functionName: "_BASE_RESERVE_" }),
        client.readContract({ address, abi: DODO_ABI, functionName: "_QUOTE_RESERVE_" }),
        client.readContract({ address, abi: DODO_ABI, functionName: "_BASE_TARGET_" }),
        client.readContract({ address, abi: DODO_ABI, functionName: "_QUOTE_TARGET_" }),
        client.readContract({ address, abi: DODO_ABI, functionName: "_R_STATUS_" }),
        client.readContract({ address, abi: DODO_ABI, functionName: "_LP_FEE_RATE_" }),
        client.readContract({ address, abi: DODO_ABI, functionName: "_MT_FEE_RATE_" }),
      ]);
      return { i, k, baseReserve: b, quoteReserve: q, baseTarget: b0, quoteTarget: q0, rStatus: Number(r), fee: (lp as bigint) + (mt as bigint) };
    } catch {
      return { i: 0n, k: 0n, baseReserve: 0n, quoteReserve: 0n, baseTarget: 0n, quoteTarget: 0n, rStatus: 0, fee: 0n };
    }
  },
);
