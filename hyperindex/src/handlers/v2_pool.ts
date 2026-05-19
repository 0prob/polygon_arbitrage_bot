import { indexer } from "envio";

indexer.onEvent(
  { contract: "UniswapV2Pool", event: "Sync", wildcard: true },
  async ({ event, context }) => {
    context.V2PoolState.set({
      id: event.srcAddress.toLowerCase(),
      address: event.srcAddress.toLowerCase(),
      lastUpdatedBlock: event.block.number,
      reserve0: event.params.reserve0,
      reserve1: event.params.reserve1,
    });
  },
);

indexer.onEvent(
  { contract: "UniswapV2Pool", event: "Swap", wildcard: true },
  async ({ event, context }) => {
    context.V2PoolState.set({
      id: event.srcAddress.toLowerCase(),
      address: event.srcAddress.toLowerCase(),
      lastUpdatedBlock: event.block.number,
      reserve0: event.params.amount0Out > 0n
        ? event.params.reserve0
        : event.params.reserve0 - event.params.amount0In,
      reserve1: event.params.amount1Out > 0n
        ? event.params.reserve1
        : event.params.reserve1 - event.params.amount1In,
    });
  },
);
