import { indexer } from "envio";

const FACTORY_PROTOCOLS: Record<string, string> = {
  "0x1f98431c8ad98523631ae4a59f267346ea31f984": "uniswap_v3",
  "0x917933899c6a5f8e37f31e19f92cdbff7e8ff0e2": "sushiswap_v3",
  "0x411b0facc3489691f28ad58c47006af5e3ab3a28": "quickswap_v3",
  "0x5f1dddbf348ac2fbe22a163e30f99f9ece3dd50a": "kyberswap_elastic",
};

const HUB_TOKENS = new Set([
  "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270", // WMATIC
  "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619", // WETH
  "0x2791bca1f2de4661ed88a30c99a7a9449aa84174", // USDC
  "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", // USDC_NATIVE
  "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", // USDT
  "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063", // DAI
  "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", // WBTC
]);

indexer.contractRegister(
  { contract: "V3Factory", event: "PoolCreated" },
  async ({ event, context }: any) => {
    const t0 = event.params.token0.toLowerCase();
    const t1 = event.params.token1.toLowerCase();
    if (HUB_TOKENS.has(t0) || HUB_TOKENS.has(t1)) {
      context.chain.UniswapV3Pool.add(event.params.pool);
    }
  },
);

indexer.onEvent(
  { contract: "V3Factory", event: "PoolCreated" },
  async ({ event, context }: any) => {
    const t0 = event.params.token0.toLowerCase();
    const t1 = event.params.token1.toLowerCase();
    if (!HUB_TOKENS.has(t0) && !HUB_TOKENS.has(t1)) return;

    const factoryAddr = event.srcAddress.toLowerCase();
    const protocol = FACTORY_PROTOCOLS[factoryAddr] ?? "unknown_v3";
    context.PoolMeta.set({
      id: event.params.pool.toLowerCase(),
      address: event.params.pool.toLowerCase(),
      protocol,
      tokens: [t0, t1],
      token0: t0,
      token1: t1,
      fee: Number(event.params.fee),
      tickSpacing: Number(event.params.tickSpacing),
      createdBlock: Number(event.block.number),
      createdTx: event.transaction.hash,
    });
  },
);
