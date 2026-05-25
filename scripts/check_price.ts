import { createPublicClient, http, parseAbi } from "viem";
import { polygon } from "viem/chains";

const WMATIC_USDC_V3 = "0xA374094527e1673A86dE625aa59517c5dE346d32";
const abi = parseAbi(["function slot0() view returns (uint160, int24, uint16, uint16, uint16, uint8, bool)"]);

const client = createPublicClient({ chain: polygon, transport: http(process.env.POLYGON_RPC_URL) });

async function main() {
  const [sqrtPriceX96] = await client.readContract({
    address: WMATIC_USDC_V3,
    abi,
    functionName: "slot0",
  });
  console.log(`sqrtPriceX96: ${sqrtPriceX96}`);
  
  const p192 = BigInt(sqrtPriceX96) * BigInt(sqrtPriceX96);
  const q192 = 1n << 192n;
  
  // 1 token0 = (p192/q192) token1
  // 1 WMATIC = (p192/q192) USDC (raw)
  const price_raw = Number(p192) / Number(q192);
  console.log(`price_raw (USDC_raw / WMATIC_raw): ${price_raw}`);
  
  const usdc_per_wmatic = price_raw * (1e18 / 1e6);
  console.log(`USDC per WMATIC: ${usdc_per_wmatic}`);
}

main();
