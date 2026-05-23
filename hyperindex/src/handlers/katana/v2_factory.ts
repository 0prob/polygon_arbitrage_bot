import { indexer } from "envio";

indexer.contractRegister(
  { contract: "SushiV2Factory", event: "PairCreated" },
  async ({ event, context }) => {
    context.chain.KatanaV2Pool.add(event.params.pair);
  },
);

indexer.onEvent(
  { contract: "SushiV2Factory", event: "PairCreated" },
  async ({ event, context }) => {
    context.PoolMeta.set({
      id: event.params.pair.toLowerCase(),
      address: event.params.pair.toLowerCase(),
      protocol: "sushiswap_v2",
      tokens: [event.params.token0.toLowerCase(), event.params.token1.toLowerCase()],
      fee: 25,
      tickSpacing: undefined,
      createdBlock: Number(event.block.number),
      createdTx: event.transaction.hash,
      poolId: undefined,
    });
  },
);
