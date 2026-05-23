import { indexer } from "envio";

indexer.contractRegister(
  { contract: "SushiV3Factory", event: "PoolCreated" },
  async ({ event, context }) => {
    context.chain.KatanaV3Pool.add(event.params.pool);
  },
);

indexer.onEvent(
  { contract: "SushiV3Factory", event: "PoolCreated" },
  async ({ event, context }) => {
    context.PoolMeta.set({
      id: event.params.pool.toLowerCase(),
      address: event.params.pool.toLowerCase(),
      protocol: "sushiswap_v3",
      tokens: [event.params.token0.toLowerCase(), event.params.token1.toLowerCase()],
      fee: Number(event.params.fee),
      tickSpacing: Number(event.params.tickSpacing),
      createdBlock: Number(event.block.number),
      createdTx: event.transaction.hash,
      poolId: undefined,
    });
  },
);
