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

async function handlePairCreated({ event, context }: any) {
  const factoryAddr = event.srcAddress.toLowerCase();
  const protocol = FACTORY_PROTOCOLS[factoryAddr] ?? "unknown_v2";
  context.chain.UniswapV2Pool.add(event.params.pair);
  context.PoolMeta.set({
    id: event.params.pair.toLowerCase(),
    address: event.params.pair.toLowerCase(),
    protocol,
    tokens: [event.params.token0.toLowerCase(), event.params.token1.toLowerCase()],
    token0: event.params.token0.toLowerCase(),
    token1: event.params.token1.toLowerCase(),
    createdBlock: event.block.number,
  });
}

indexer.contractRegister({ contract: "QuickswapV2Factory", event: "PairCreated" }, handlePairCreated);
indexer.contractRegister({ contract: "SushiswapV2Factory", event: "PairCreated" }, handlePairCreated);
indexer.contractRegister({ contract: "UniswapV2Factory", event: "PairCreated" }, handlePairCreated);
indexer.contractRegister({ contract: "DfynV2Factory", event: "PairCreated" }, handlePairCreated);
indexer.contractRegister({ contract: "ApeswapV2Factory", event: "PairCreated" }, handlePairCreated);
indexer.contractRegister({ contract: "MeshswapV2Factory", event: "PairCreated" }, handlePairCreated);
indexer.contractRegister({ contract: "JetswapV2Factory", event: "PairCreated" }, handlePairCreated);
indexer.contractRegister({ contract: "ComethswapV2Factory", event: "PairCreated" }, handlePairCreated);
