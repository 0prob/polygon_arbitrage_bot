import { indexer } from "envio";

indexer.onEvent(
  { contract: "DodoPool", event: "Sync" },
  async ({ event, context }: any) => {
    context.DodoPoolState.set({
      id: event.srcAddress.toLowerCase(),
      address: event.srcAddress.toLowerCase(),
      lastUpdatedBlock: Number(event.block.number),
      baseReserve: event.params.reserve0,
      quoteReserve: event.params.reserve1,
      targetBase: event.params.reserve0,
      targetQuote: event.params.reserve1,
      rStatus: 0,
      k: 0n,
      fee: 0n,
    });
  },
);
