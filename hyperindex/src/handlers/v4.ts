import { indexer } from "envio";
import { fetchTokenMeta } from "../effects/token_metadata";

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
      fee: Number(event.params.fee),
      tickSpacing: Number(event.params.tickSpacing),
      createdBlock: Number(event.block.number),
      createdTx: undefined,
      poolId: undefined,
    });

    context.V4PoolState.set({
      id: poolId,
      address: poolId,
      lastUpdatedBlock: Number(event.block.number),
      sqrtPriceX96: event.params.sqrtPriceX96,
      liquidity: 0n,
      tick: Number(event.params.tick),
      fee: event.params.fee,
      tickSpacing: Number(event.params.tickSpacing),
      hooks: event.params.hooks.toLowerCase(),
    });

    const [c0meta, c1meta] = await Promise.all([
      context.effect(fetchTokenMeta, { address: currency0 }),
      context.effect(fetchTokenMeta, { address: currency1 }),
    ]);
    context.TokenMeta.set({ id: currency0, address: currency0, decimals: c0meta.decimals });
    context.TokenMeta.set({ id: currency1, address: currency1, decimals: c1meta.decimals });
  },
);

indexer.onEvent(
  { contract: "PoolManager", event: "Swap" },
  async ({ event, context }) => {
    const poolId = event.params.id.toLowerCase();
    const existing = await context.V4PoolState.get(poolId);
    if (!existing) return;

    context.V4PoolState.set({
      ...existing,
      id: poolId,
      address: poolId,
      lastUpdatedBlock: Number(event.block.number),
      sqrtPriceX96: event.params.sqrtPriceX96,
      liquidity: event.params.liquidity,
      tick: Number(event.params.tick),
      fee: event.params.fee,
    });
  },
);
