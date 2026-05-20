import { indexer } from "envio";

indexer.onEvent(
  { contract: "UniswapV3Pool", event: "Swap" },
  async ({ event, context }: any) => {
    context.V3PoolState.set({
      id: event.srcAddress.toLowerCase(),
      address: event.srcAddress.toLowerCase(),
      lastUpdatedBlock: Number(event.block.number),
      sqrtPriceX96: event.params.sqrtPriceX96,
      liquidity: event.params.liquidity,
      tick: Number(event.params.tick),
    });
  },
);
