import { indexer } from "envio";

indexer.onEvent(
  { contract: "UniswapV2Pool", event: "Sync", wildcard: true },
  async ({ event, context }) => {
    context.V2PoolState.set({
      id: event.srcAddress.toLowerCase(),
      address: event.srcAddress.toLowerCase(),
      lastUpdatedBlock: Number(event.block.number),
      reserve0: event.params.reserve0,
      reserve1: event.params.reserve1,
    });
  },
);
