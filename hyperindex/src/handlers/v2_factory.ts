import { indexer } from "envio";

const FACTORY_PROTOCOLS: Record<string, string> = {
  "0x5757371414417b8c6caad45baef941abc7d3ab32": "quickswap_v2",
  "0xc35dadb65012ec5796536bd9864ed8773abc74c4": "sushiswap_v2",
  "0x9e5a52f57b3038f1b8eee45f28b3c1967e22799c": "uniswap_v2",
  "0xe7fb3e833efe5f9c441105eb65ef8b261266423b": "dfyn_v2",
  "0xcf083be4164828f00cae704ec15a36d711491284": "apeswap_v2",
  "0x9f3044f7f9fc8bc9ed615d54845b4577b833282d": "meshswap_v2",
  "0x668ad0ed2622c62e24f0d5ab6b6ac1b9d2cd4ac7": "jetswap_v2",
  "0x800b052609c355ca8103e06f022aa30647ead60a": "comethswap_v2",
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
  { contract: "V2Factory", event: "PairCreated" },
  async ({ event, context }: any) => {
    const t0 = event.params.token0.toLowerCase();
    const t1 = event.params.token1.toLowerCase();
    if (HUB_TOKENS.has(t0) || HUB_TOKENS.has(t1)) {
      context.chain.UniswapV2Pool.add(event.params.pair);
    }
  },
);

indexer.onEvent(
  { contract: "V2Factory", event: "PairCreated" },
  async ({ event, context }: any) => {
    const t0 = event.params.token0.toLowerCase();
    const t1 = event.params.token1.toLowerCase();
    if (!HUB_TOKENS.has(t0) && !HUB_TOKENS.has(t1)) return;

    const factoryAddr = event.srcAddress.toLowerCase();
    const protocol = FACTORY_PROTOCOLS[factoryAddr] ?? "unknown_v2";
    context.PoolMeta.set({
      id: event.params.pair.toLowerCase(),
      address: event.params.pair.toLowerCase(),
      protocol,
      tokens: [t0, t1],
      token0: t0,
      token1: t1,
      createdBlock: Number(event.block.number),
      createdTx: event.transaction.hash,
    });
  },
);
