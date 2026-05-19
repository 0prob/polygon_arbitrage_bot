import { indexer } from "envio";

indexer.onEvent(
  { contract: "KatanaV2Pool", event: "Sync", chainId: 747474 },
  async ({ event, context }: any) => {
    context.V2PoolState.set({
      id: event.srcAddress.toLowerCase(),
      address: event.srcAddress.toLowerCase(),
      lastUpdatedBlock: Number(event.block.number),
      reserve0: event.params.reserve0,
      reserve1: event.params.reserve1,
    });
  },
);
