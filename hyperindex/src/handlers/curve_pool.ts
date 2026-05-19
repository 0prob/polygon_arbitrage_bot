import { indexer } from "envio";

indexer.onEvent(
  { contract: "CurvePool", event: "Sync", wildcard: true },
  async ({ event, context }) => {
    context.CurvePoolState.set({
      id: event.srcAddress.toLowerCase(),
      address: event.srcAddress.toLowerCase(),
      lastUpdatedBlock: event.block.number,
      balances: [event.params.reserve0, event.params.reserve1],
      A: 0n,
      fee: 0n,
    });
  },
);
