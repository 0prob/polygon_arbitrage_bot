import { createPublicClient, http, parseAbi } from "viem";
import { polygon } from "viem/chains";

const V3_FACTORY = "0x1f98431c8ad98523631ae4a59f267346ea31f984";
const abi = parseAbi([
  "function getPool(address,address,uint24) view returns (address)",
]);

const tokens = [
  { symbol: "WMATIC", address: "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270" },
  { symbol: "USDC", address: "0x2791bca1f2de4661ed88a30c99a7a9449aa84174" },
  { symbol: "WETH", address: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619" },
  { symbol: "USDT", address: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f" },
  { symbol: "DAI", address: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063" },
  { symbol: "WBTC", address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6" },
  { symbol: "LINK", address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39" },
  { symbol: "AAVE", address: "0xd6df3d56a4adc717fd2b414486f5469903ef47f0" },
];

const fees = [100, 500, 3000, 10000];

const client = createPublicClient({ chain: polygon, transport: http(process.env.POLYGON_RPC_URL) });

async function main() {
  const pools: any[] = [];
  for (let i = 0; i < tokens.length; i++) {
    for (let j = i + 1; j < tokens.length; j++) {
      for (const fee of fees) {
        try {
          const addr = await client.readContract({
            address: V3_FACTORY,
            abi,
            functionName: "getPool",
            args: [tokens[i].address, tokens[j].address, fee],
          });
          if (addr !== "0x0000000000000000000000000000000000000000") {
            pools.push({
              address: addr.toLowerCase(),
              protocol: "uniswap_v3",
              tokens: [tokens[i].address.toLowerCase(), tokens[j].address.toLowerCase()],
              fee,
              symbols: `${tokens[i].symbol}/${tokens[j].symbol} ${fee}`
            });
          }
        } catch {}
      }
    }
  }
  console.log(JSON.stringify(pools, null, 2));
}

main();
