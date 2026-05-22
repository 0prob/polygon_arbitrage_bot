import { indexer } from "envio";

indexer.contractRegister(
  { contract: "SushiV3Factory", event: "PoolCreated" },
  async ({ event, context }: any) => {
    context.chain.KatanaV3Pool.add(event.params.pool);
  },
);

indexer.onEvent(
  { contract: "SushiV3Factory", event: "PoolCreated" },
  async ({ event, context }: any) => {
    context.PoolMeta.set({
      id: event.params.pool.toLowerCase(),
      address: event.params.pool.toLowerCase(),
      protocol: "sushiswap_v3",
      tokens: [event.params.token0.toLowerCase(), event.params.token1.toLowerCase()],
      token0: event.params.token0.toLowerCase(),
      token1: event.params.token1.toLowerCase(),
      createdBlock: Number(event.block.number),
      createdTx: event.transaction.hash,
    });
  },
);
