import { indexer } from "envio";

/**
 * In-memory cache for immutable pool fees + tickSpacing (V3).
 * Eliminates repeated DB reads of PoolMeta on every Swap/Initialize during historical backfill.
 * This is the highest-leverage change for improving "events per second" backfill rate on Polygon.
 */
const poolFeeCache = new Map<string, { fee?: number; tickSpacing?: number }>();

function getCachedMeta(poolId: string) {
  return poolFeeCache.get(poolId);
}

function setCachedMeta(poolId: string, fee?: number, tickSpacing?: number) {
  const prev = poolFeeCache.get(poolId) ?? {};
  poolFeeCache.set(poolId, {
    fee: fee ?? prev.fee,
    tickSpacing: tickSpacing ?? prev.tickSpacing,
  });
}

indexer.onEvent(
  { contract: "UniswapV3Pool", event: "Initialize" },
  async ({ event, context }) => {
    const poolId = event.srcAddress.toLowerCase();

    let cached = getCachedMeta(poolId);
    if (!cached || cached.fee === undefined || cached.tickSpacing === undefined) {
      const [existing, meta] = await Promise.all([
        context.V3PoolState.get(poolId),
        context.PoolMeta.get(poolId),
      ]);
      const fee = existing?.fee ?? meta?.fee;
      const tickSpacing = existing?.tickSpacing ?? meta?.tickSpacing;
      if (fee !== undefined || tickSpacing !== undefined) setCachedMeta(poolId, fee, tickSpacing);
      context.V3PoolState.set({
        id: poolId,
        address: poolId,
        lastUpdatedBlock: Number(event.block.number),
        sqrtPriceX96: event.params.sqrtPriceX96,
        liquidity: 0n,
        tick: Number(event.params.tick),
        fee,
        tickSpacing,
      });
      return;
    }

    const existing = await context.V3PoolState.get(poolId);
    context.V3PoolState.set({
      id: poolId,
      address: poolId,
      lastUpdatedBlock: Number(event.block.number),
      sqrtPriceX96: event.params.sqrtPriceX96,
      liquidity: 0n,
      tick: Number(event.params.tick),
      fee: existing?.fee ?? cached.fee,
      tickSpacing: existing?.tickSpacing ?? cached.tickSpacing,
    });
  },
);

indexer.onEvent(
  { contract: "UniswapV3Pool", event: "Swap" },
  async ({ event, context }) => {
    const poolId = event.srcAddress.toLowerCase();

    const cached = getCachedMeta(poolId);
    if (cached && cached.fee !== undefined && cached.tickSpacing !== undefined) {
      const existing = await context.V3PoolState.get(poolId);
      context.V3PoolState.set({
        id: poolId,
        address: poolId,
        lastUpdatedBlock: Number(event.block.number),
        sqrtPriceX96: event.params.sqrtPriceX96,
        liquidity: event.params.liquidity,
        tick: Number(event.params.tick),
        fee: existing?.fee ?? cached.fee,
        tickSpacing: existing?.tickSpacing ?? cached.tickSpacing,
      });
      return;
    }

    // Cold path (first event for this pool in the process)
    const [existing, meta] = await Promise.all([
      context.V3PoolState.get(poolId),
      context.PoolMeta.get(poolId),
    ]);
    const fee = existing?.fee ?? meta?.fee;
    const tickSpacing = existing?.tickSpacing ?? meta?.tickSpacing;
    if (fee !== undefined || tickSpacing !== undefined) setCachedMeta(poolId, fee, tickSpacing);
    context.V3PoolState.set({
      id: poolId,
      address: poolId,
      lastUpdatedBlock: Number(event.block.number),
      sqrtPriceX96: event.params.sqrtPriceX96,
      liquidity: event.params.liquidity,
      tick: Number(event.params.tick),
      fee,
      tickSpacing,
    });
  },
);
