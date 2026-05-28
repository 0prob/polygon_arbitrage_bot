import { indexer } from "envio";

/**
 * V2 Sync handler — optimized for arbitrage.
 * Always preserves the pool's trading fee (from PoolMeta at creation).
 * This makes V2PoolState rows self-contained for fast arb quote calculations
 * without requiring a join to PoolMeta for the fee.
 */
indexer.onEvent(
  { contract: "UniswapV2Pool", event: "Sync" },
  async ({ event, context }) => {
    const poolId = event.srcAddress.toLowerCase();

    const [existing, meta] = await Promise.all([
      context.V2PoolState.get(poolId),
      context.PoolMeta.get(poolId),
    ]);

    context.V2PoolState.set({
      id: poolId,
      address: poolId,
      lastUpdatedBlock: Number(event.block.number),
      reserve0: event.params.reserve0,
      reserve1: event.params.reserve1,
      fee: existing?.fee ?? meta?.fee ?? undefined,
    });
  },
);
