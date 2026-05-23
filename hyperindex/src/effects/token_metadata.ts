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

const ERC20_ABI = parseAbi([
  "function decimals() view returns (uint8)",
]);

export const fetchTokenMeta = createEffect(
  {
    name: "fetchTokenMeta",
    input: { address: S.string },
    output: { address: S.string, decimals: S.number },
    rateLimit: { calls: 20, per: "second" },
    cache: true,
  },
  async ({ input }) => {
    try {
      const decimals = await client.readContract({
        address: input.address as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "decimals",
      });
      return { address: input.address, decimals: Number(decimals) };
    } catch {
      return { address: input.address, decimals: 18 };
    }
  },
);
