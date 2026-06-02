const { JsonRpcProvider } = require("ethers");

// Need a working Polygon RPC.
const rpcUrl = "https://polygon-rpc.com";
const provider = new JsonRpcProvider(rpcUrl);

const contracts = {
  QuickswapV2: "0x5757371414417b8c6caad45baef941abc7d3ab32",
  UniswapV3: "0x1f98431c8ad98523631ae4a59f267346ea31f984",
  BalancerVault: "0xba12222222228d8ba445958a75a0704d566bf2c8",
  CurveRegistry: "0x296d2B5C23833A70D07c8fCBB97d846c1ff90DDD",
  DODOV2_DVM: "0x79887f65f83bdf15bcc8736b5e5bcdb48fb8fe13",
  DODOV2_DPP: "0xdfaf9584f5d229a9dbe5978523317820a8897c5a",
  DODOV2_DSP: "0x4d97e480ea49ac57ce8c1f7c79b1a0c3d4adc7c4",
  UniswapV4_PoolManager: "0x67366782805870060151383f4bbff9dab53e5cd6",
  SushiV2: "0xc35dadb65012ec5796536bd9864ed8773abc74c4",
  Dfyn: "0xe7fb3e833efe5f9c441105eb65ef8b261266423b",
  Apeswap: "0xcf083be4164828f00cae704ec15a36d711491284",
  Meshswap: "0x9f3044f7f9fc8bc9ed615d54845b4577b833282d",
  Jetswap: "0x668ad0ed2622c62e24f0d5ab6b6ac1b9d2cd4ac7",
  Cometh: "0x800b052609c355ca8103e06f022aa30647ead60a",
  SushiV3: "0x917933899c6a5f8e37f31e19f92cdbff7e8ff0e2",
  QuickswapV3: "0x411b0facc3489691f28ad58c47006af5e3ab3a28",
  Kyberswap: "0x5f1dddbf348ac2fbe22a163e30f99f9ece3dd50a",
};

async function findDeploymentBlock(name, address, latestBlock) {
  let low = 0;
  let high = latestBlock;
  let best = latestBlock;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    try {
      const code = await provider.getCode(address, mid);
      if (code !== "0x") {
        best = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    } catch (e) {
      if (e.message.includes("missing trie node")) {
        // Some public nodes don't have full archive state for all blocks.
        // If we hit this, it means we probably can't binary search reliably.
        console.error(`Archive node required. Failed at block ${mid}`);
        return -1;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  return best;
}

async function main() {
  try {
    const latest = await provider.getBlockNumber();
    console.log(`Latest block: ${latest}`);

    for (const [name, addr] of Object.entries(contracts)) {
      console.log(`Searching for ${name} (${addr})...`);
      const block = await findDeploymentBlock(name, addr, latest);
      console.log(`${name}: ${block}`);
    }
  } catch (e) {
    console.error(e);
  }
}

main();
