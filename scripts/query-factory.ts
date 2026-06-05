import { createPublicClient, http } from "viem";
import { polygon } from "viem/chains";

const rpcUrl = process.env.POLYGON_RPC_URL || "https://polygon-rpc.com";
const client = createPublicClient({
  chain: polygon,
  transport: http(rpcUrl),
});

const pools = ["0x982b2A12D00e9Bf069abd6AAdEC2bDF83b241f7A", "0x13A26370B389522B2a28F326b75BEBeFa5c16180"];

for (const poolAddress of pools) {
  try {
    const factory = await client.readContract({
      address: poolAddress as `0x${string}`,
      abi: [{ name: "factory", type: "function", inputs: [], outputs: [{ type: "address" }] }],
      functionName: "factory",
    });
    console.log(`Pool ${poolAddress} factory: ${factory}`);
  } catch (e: any) {
    console.error(`Failed to query factory for ${poolAddress}:`, e.message);
  }
}
