import { createPublicClient, http } from "viem";
import { polygon } from "viem/chains";

const rpcUrl = process.env.POLYGON_RPC_URL || "https://polygon-rpc.com";
const client = createPublicClient({
  chain: polygon,
  transport: http(rpcUrl),
});

const pools = [
  "0xbcFc55307F969a0fD99D9B6cb4a5bD8AD42c812E",
  "0x82ca29f73e05d60a7beff48790390b6e91181c86",
  "0xcd72ef8ea618508a4ed54cd6a4124b15fe204350",
  "0xe794f90765b9efe578ff6bb905d5f7a6a0efc352",
];

for (const poolAddress of pools) {
  console.log(`\n-------------------------------------`);
  console.log(`Pool Address: ${poolAddress}`);

  let token0 = "N/A";
  try {
    const res = await client.readContract({
      address: poolAddress as `0x${string}`,
      abi: [{ name: "token0", type: "function", inputs: [], outputs: [{ type: "address" }] }],
      functionName: "token0",
    });
    token0 = String(res);
  } catch (e: any) {
    try {
      // Maybe Curve or Balancer or some other method?
      // Let's try coins(0) for Curve
      const res = await client.readContract({
        address: poolAddress as `0x${string}`,
        abi: [{ name: "coins", type: "function", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] }],
        functionName: "coins",
        args: [0n],
      });
      token0 = String(res);
    } catch {}
  }
  console.log(`Token 0/Coins 0: ${token0}`);

  let token1 = "N/A";
  try {
    const res = await client.readContract({
      address: poolAddress as `0x${string}`,
      abi: [{ name: "token1", type: "function", inputs: [], outputs: [{ type: "address" }] }],
      functionName: "token1",
    });
    token1 = String(res);
  } catch (e: any) {
    try {
      const res = await client.readContract({
        address: poolAddress as `0x${string}`,
        abi: [{ name: "coins", type: "function", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] }],
        functionName: "coins",
        args: [1n],
      });
      token1 = String(res);
    } catch {}
  }
  console.log(`Token 1/Coins 1: ${token1}`);

  let fee = "N/A";
  try {
    const f = await client.readContract({
      address: poolAddress as `0x${string}`,
      abi: [{ name: "fee", type: "function", inputs: [], outputs: [{ type: "uint24" }] }],
      functionName: "fee",
    });
    fee = String(f);
  } catch {}
  console.log(`Fee:          ${fee}`);

  let liquidity = "N/A";
  try {
    const l = await client.readContract({
      address: poolAddress as `0x${string}`,
      abi: [{ name: "liquidity", type: "function", inputs: [], outputs: [{ type: "uint128" }] }],
      functionName: "liquidity",
    });
    liquidity = String(l);
  } catch {}
  console.log(`Liquidity:    ${liquidity}`);
}
