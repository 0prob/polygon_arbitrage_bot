import { createPublicClient, http } from "viem";
import { polygon } from "viem/chains";

const rpcUrl = process.env.POLYGON_RPC_URL || "https://polygon-rpc.com";
const client = createPublicClient({
  chain: polygon,
  transport: http(rpcUrl),
});

const tokens = ["0x1d74a8ead6e711fc022f29f7219a48f6ec454284", "0x7dd7912c1b0e0cc6a584fe850bd2c1dbc2cc9461"];

for (const tokenAddress of tokens) {
  try {
    const [symbol, name, decimals] = await Promise.all([
      client.readContract({
        address: tokenAddress as `0x${string}`,
        abi: [{ name: "symbol", type: "function", inputs: [], outputs: [{ type: "string" }] }],
        functionName: "symbol",
      }),
      client.readContract({
        address: tokenAddress as `0x${string}`,
        abi: [{ name: "name", type: "function", inputs: [], outputs: [{ type: "string" }] }],
        functionName: "name",
      }),
      client.readContract({
        address: tokenAddress as `0x${string}`,
        abi: [{ name: "decimals", type: "function", inputs: [], outputs: [{ type: "uint8" }] }],
        functionName: "decimals",
      }),
    ]);

    console.log(`\nToken Address: ${tokenAddress}`);
    console.log(`Symbol:        ${symbol}`);
    console.log(`Name:          ${name}`);
    console.log(`Decimals:      ${decimals}`);
  } catch (e: any) {
    console.error(`\nFailed to query token ${tokenAddress}:`, e.message);
  }
}
