import { indexer } from "envio";

/**
 * V3 pool state handlers — optimized for arbitrage.
 *
 * Fee is sourced from PoolMeta (set at PoolCreated time from the factory event).
 * This ensures V3PoolState rows contain the authoritative fee without requiring
 * joins for the most common arb use case (price + liquidity + fee calculations).
 *
 * Note: Standard Uniswap V3 Swap/Initialize events do not emit fee/tickSpacing.
 * Those come only from the factory.
 */
indexer.onEvent(
  { contract: "UniswapV3Pool", event: "Initialize" },
  async ({ event, context }) => {
    const poolId = event.srcAddress.toLowerCase();

    const [existing, meta] = await Promise.all([
      context.V3PoolState.get(poolId),
      context.PoolMeta.get(poolId),
    ]);

    context.V3PoolState.set({
      id: poolId,
      address: poolId,
      lastUpdatedBlock: Number(event.block.number),
      sqrtPriceX96: event.params.sqrtPriceX96,
      liquidity: 0n,
      tick: Number(event.params.tick),
      fee: existing?.fee ?? meta?.fee ?? undefined,
      tickSpacing: existing?.tickSpacing ?? meta?.tickSpacing ?? undefined,
    });
  },
);

indexer.onEvent(
  { contract: "UniswapV3Pool", event: "Swap" },
  async ({ event, context }) => {
    const poolId = event.srcAddress.toLowerCase();

    const [existing, meta] = await Promise.all([
      context.V3PoolState.get(poolId),
      context.PoolMeta.get(poolId),
    ]);

    context.V3PoolState.set({
      id: poolId,
      address: poolId,
      lastUpdatedBlock: Number(event.block.number),
      sqrtPriceX96: event.params.sqrtPriceX96,
      liquidity: event.params.liquidity,
      tick: Number(event.params.tick),
      fee: existing?.fee ?? meta?.fee ?? undefined,
      tickSpacing: existing?.tickSpacing ?? meta?.tickSpacing ?? undefined,
    });
  },
);
