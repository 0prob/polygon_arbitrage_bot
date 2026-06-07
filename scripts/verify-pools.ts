import { createPublicClient, http } from "viem";
import { polygon } from "viem/chains";
import { writeFileSync, readFileSync } from "fs";

const client = createPublicClient({
  chain: polygon,
  transport: http("https://polygon-mainnet.core.chainstack.com/03efdc1db374a4df08d42e72b1408637"),
});

const POOLS_PATH = "scripts/pools.json";

async function run() {
  console.log("Loading pools.json...");
  const raw = readFileSync(POOLS_PATH, "utf-8");
  const pools = JSON.parse(raw) as any[];

  const verifiedPools: any[] = [];

  for (const pool of pools) {
    const addr = pool.address as `0x${string}`;
    console.log(`\nVerifying pool ${addr}...`);

    try {
      const [token0, token1, fee] = await Promise.all([
        client.readContract({
          address: addr,
          abi: [{ name: "token0", type: "function", inputs: [], outputs: [{ type: "address" }] }],
          functionName: "token0",
        }),
        client.readContract({
          address: addr,
          abi: [{ name: "token1", type: "function", inputs: [], outputs: [{ type: "address" }] }],
          functionName: "token1",
        }),
        client.readContract({
          address: addr,
          abi: [{ name: "fee", type: "function", inputs: [], outputs: [{ type: "uint24" }] }],
          functionName: "fee",
        }),
      ]);

      console.log(`Actual token0: ${token0}`);
      console.log(`Actual token1: ${token1}`);
      console.log(`Actual fee:    ${fee}`);

      verifiedPools.push({
        address: addr.toLowerCase(),
        protocol: pool.protocol,
        token0: String(token0).toLowerCase(),
        token1: String(token1).toLowerCase(),
        tokens: [String(token0).toLowerCase(), String(token1).toLowerCase()],
        fee: Number(fee),
      });
    } catch (e: any) {
      console.error(`Failed to verify ${addr}: ${e.message}`);
    }
  }

  console.log(`\nWriting verified pools to ${POOLS_PATH}...`);
  writeFileSync(POOLS_PATH, JSON.stringify(verifiedPools, null, 2));
  console.log("Done!");
}

run();
