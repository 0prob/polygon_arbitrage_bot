import { indexer } from "envio";

indexer.onEvent(
  { contract: "PoolManager", event: "Initialize" },
  async ({ event, context }) => {
    const poolId = event.params.id.toLowerCase();
    const currency0 = event.params.currency0.toLowerCase();
    const currency1 = event.params.currency1.toLowerCase();

    context.PoolMeta.set({
      id: poolId,
      address: poolId,
      protocol: "uniswap_v4",
      tokens: [currency0, currency1],
      token0: currency0,
      token1: currency1,
      createdBlock: event.block.number,
    });

    context.V4PoolState.set({
      id: poolId,
      address: poolId,
      lastUpdatedBlock: event.block.number,
      sqrtPriceX96: event.params.sqrtPriceX96,
      liquidity: 0n,
      tick: Number(event.params.tick),
      fee: event.params.fee,
      tickSpacing: Number(event.params.tickSpacing),
      hooks: event.params.hooks.toLowerCase(),
    });
  },
);

indexer.onEvent(
  { contract: "PoolManager", event: "Swap" },
  async ({ event, context }) => {
    const poolId = event.params.id.toLowerCase();

    context.V4PoolState.set({
      id: poolId,
      address: poolId,
      lastUpdatedBlock: event.block.number,
      sqrtPriceX96: event.params.sqrtPriceX96,
      liquidity: event.params.liquidity,
      tick: Number(event.params.tick),
      fee: event.params.fee,
      tickSpacing: 0,
      hooks: "",
    });
  },
);
