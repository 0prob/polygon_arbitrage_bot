import { createEffect, S } from "envio";
import { createPublicClient, http, parseAbi } from "viem";
import { polygon } from "viem/chains";
import { STATIC_TOKEN_DECIMALS } from "./token_registry";

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

const ERC20_ABI = parseAbi([
  "function decimals() view returns (uint8)",
]);

function safeDecimals(d: number): number {
  if (isNaN(d) || d < 0 || d > 255) return 18;
  return d;
}

export const fetchTokenMeta = createEffect(
  {
    name: "fetchTokenMeta",
    input: { address: S.string },
    output: { address: S.string, decimals: S.number },
    rateLimit: { calls: 100, per: "second" },
    cache: false,
  },
  async ({ input }) => {
    const cached = STATIC_TOKEN_DECIMALS[input.address.toLowerCase()];
    if (cached !== undefined) return { address: input.address, decimals: cached };

    try {
      const decimals = await client.readContract({
        address: input.address as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "decimals",
      });
      return { address: input.address, decimals: safeDecimals(Number(decimals)) };
    } catch {
      return { address: input.address, decimals: 18 };
    }
  },
);
