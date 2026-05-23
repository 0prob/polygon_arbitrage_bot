import { indexer } from "envio";

indexer.onEvent(
  { contract: "DodoPool", event: "Sync" },
  async ({ event, context }) => {
    const addr = event.srcAddress.toLowerCase();
    const existing = await context.DodoPoolState.get(addr);
    if (!existing) return;

    context.DodoPoolState.set({
      ...existing,
      lastUpdatedBlock: Number(event.block.number),
      baseReserve: event.params.reserve0,
      quoteReserve: event.params.reserve1,
    });
  },
);
