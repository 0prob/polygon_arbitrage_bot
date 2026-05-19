import { indexer } from "envio";

indexer.contractRegister(
  { contract: "SushiV2Factory", event: "PairCreated", chainId: 747474 },
  async ({ event, context }: any) => {
    context.chain.KatanaV2Pool.add(event.params.pair);
  },
);

indexer.onEvent(
  { contract: "SushiV2Factory", event: "PairCreated", chainId: 747474 },
  async ({ event, context }: any) => {
    context.PoolMeta.set({
      id: event.params.pair.toLowerCase(),
      address: event.params.pair.toLowerCase(),
      protocol: "sushiswap_v2",
      tokens: [event.params.token0.toLowerCase(), event.params.token1.toLowerCase()],
      token0: event.params.token0.toLowerCase(),
      token1: event.params.token1.toLowerCase(),
      createdBlock: Number(event.block.number),
    });
  },
);
