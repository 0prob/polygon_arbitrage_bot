import { indexer } from "envio";

/**
 * In-memory cache for immutable pool fees.
 * Eliminates repeated DB reads of PoolMeta on every Sync during historical backfill.
 * Fees are set once at PairCreated time and never change for V2 pools.
 * First event per pool pays 1x PoolMeta.get; all subsequent events are pure memory + DB write.
 * This is the highest-leverage change for improving "events per second" backfill rate.
 */
const poolFeeCache = new Map<string, number>();

indexer.onEvent(
  { contract: "UniswapV2Pool", event: "Sync" },
  async ({ event, context }) => {
    const poolId = event.srcAddress.toLowerCase();

    let fee = poolFeeCache.get(poolId);
    if (fee === undefined) {
      const [existing, meta] = await Promise.all([
        context.V2PoolState.get(poolId),
        context.PoolMeta.get(poolId),
      ]);
      fee = existing?.fee ?? meta?.fee;
      if (fee !== undefined) poolFeeCache.set(poolId, fee);
      context.V2PoolState.set({
        id: poolId,
        address: poolId,
        lastUpdatedBlock: Number(event.block.number),
        reserve0: event.params.reserve0,
        reserve1: event.params.reserve1,
        fee,
      });
      return;
    }

    // Fast path: fee known from cache, only need the mutable state row (or create fresh)
    context.V2PoolState.set({
      id: poolId,
      address: poolId,
      lastUpdatedBlock: Number(event.block.number),
      reserve0: event.params.reserve0,
      reserve1: event.params.reserve1,
      fee,
    });
  },
);
