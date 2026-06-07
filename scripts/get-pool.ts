import { createPublicClient, http } from "viem";
import { polygon } from "viem/chains";

const client = createPublicClient({
  chain: polygon,
  transport: http("https://polygon-mainnet.core.chainstack.com/03efdc1db374a4df08d42e72b1408637"),
});

const FACTORY = "0x1f98431c8ad98523631ae4a59f267346ea31f984";

const tokens = {
  WMATIC: "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
};

async function checkPool(tokenA: string, tokenB: string, fee: number) {
  try {
    const pool = await client.readContract({
      address: FACTORY,
      abi: [
        {
          name: "getPool",
          type: "function",
          inputs: [
            { name: "tokenA", type: "address" },
            { name: "tokenB", type: "address" },
            { name: "fee", type: "uint24" },
          ],
          outputs: [{ type: "address" }],
        },
      ],
      functionName: "getPool",
      args: [tokenA as `0x${string}`, tokenB as `0x${string}`, fee],
    });
    console.log(`Pool ${tokenA} / ${tokenB} @ ${fee}: ${pool}`);
  } catch (e: any) {
    console.error(`Error querying pool: ${e.message}`);
  }
}

async function run() {
  await checkPool(tokens.WMATIC, tokens.WETH, 500);
}

run();
