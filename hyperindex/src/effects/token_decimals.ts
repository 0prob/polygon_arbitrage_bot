import { createEffect, S } from "envio";
import { createPublicClient, http, parseAbi } from "viem";
import { polygon } from "viem/chains";

const client = createPublicClient({
  chain: polygon,
  transport: http(process.env.POLYGON_RPC_URL!, { batch: true }),
});

const ERC20_ABI = parseAbi(["function decimals() view returns (uint8)"]);

export const fetchTokenDecimals = createEffect(
  {
    name: "fetchTokenDecimals",
    input: { token: S.string },
    output: { decimals: S.number },
    rateLimit: { calls: 10, per: "second" },
    cache: true,
  },
  async ({ input }) => {
    try {
      const decimals = await client.readContract({
        address: input.token as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "decimals",
      });
      return { decimals: Number(decimals) };
    } catch {
      return { decimals: 18 };
    }
  },
);
