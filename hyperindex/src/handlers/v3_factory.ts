import { indexer } from "envio";

const FACTORY_PROTOCOLS: Record<string, string> = {
  "0x1f98431c8ad98523631ae4a59f267346ea31f984": "uniswap_v3",
  "0x917933899c6a5f8e37f31e19f92cdbff7e8ff0e2": "sushiswap_v3",
  "0x411b0facc3489691f28ad58c47006af5e3ab3a28": "quickswap_v3",
  "0x5f1dddbf348ac2fbe22a163e30f99f9ece3dd50a": "kyberswap_elastic",
};

async function handlePoolCreated({ event, context }: any) {
  const factoryAddr = event.srcAddress.toLowerCase();
  const protocol = FACTORY_PROTOCOLS[factoryAddr] ?? "unknown_v3";
  context.chain.UniswapV3Pool.add(event.params.pool);
  context.PoolMeta.set({
    id: event.params.pool.toLowerCase(),
    address: event.params.pool.toLowerCase(),
    protocol,
    tokens: [event.params.token0.toLowerCase(), event.params.token1.toLowerCase()],
    token0: event.params.token0.toLowerCase(),
    token1: event.params.token1.toLowerCase(),
    createdBlock: event.block.number,
  });
}

indexer.contractRegister({ contract: "UniswapV3Factory", event: "PoolCreated" }, handlePoolCreated);
indexer.contractRegister({ contract: "SushiswapV3Factory", event: "PoolCreated" }, handlePoolCreated);
indexer.contractRegister({ contract: "QuickswapV3Factory", event: "PoolCreated" }, handlePoolCreated);
indexer.contractRegister({ contract: "KyberswapElasticFactory", event: "PoolCreated" }, handlePoolCreated);
