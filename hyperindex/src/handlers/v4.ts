import { indexer } from "envio";
import { fetchTokenMeta } from "../effects/token_metadata";

const v4MetaCache = new Map<string, { tickSpacing: number; hooks: string }>();

indexer.onEvent(
  { contract: "PoolManager", event: "Initialize" },
  async ({ event, context }) => {
    const poolId = event.params.id.toLowerCase();
    const currency0 = event.params.currency0.toLowerCase();
    const currency1 = event.params.currency1.toLowerCase();
    const tickSpacing = Number(event.params.tickSpacing);
    const hooks = event.params.hooks.toLowerCase();

    v4MetaCache.set(poolId, { tickSpacing, hooks });

    context.PoolMeta.set({
      id: poolId,
      address: poolId,
      protocol: "uniswap_v4",
      tokens: [currency0, currency1],
      fee: Number(event.params.fee),
      tickSpacing,
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
      tickSpacing,
      hooks,
    });

    const [c0meta, c1meta] = await Promise.all([
      context.effect(fetchTokenMeta, { address: currency0, blockNumber: BigInt(event.block.number) }),
      context.effect(fetchTokenMeta, { address: currency1, blockNumber: BigInt(event.block.number) }),
    ]);
    context.TokenMeta.set({ id: currency0, address: currency0, decimals: c0meta.decimals });
    context.TokenMeta.set({ id: currency1, address: currency1, decimals: c1meta.decimals });
  },
);

indexer.onEvent(
  { contract: "PoolManager", event: "Swap" },
  async ({ event, context }) => {
    const poolId = event.params.id.toLowerCase();

    const cached = v4MetaCache.get(poolId);
    if (cached) {
      context.V4PoolState.set({
        id: poolId,
        address: poolId,
        lastUpdatedBlock: Number(event.block.number),
        sqrtPriceX96: event.params.sqrtPriceX96,
        liquidity: event.params.liquidity,
        tick: Number(event.params.tick),
        fee: event.params.fee,
        tickSpacing: cached.tickSpacing,
        hooks: cached.hooks,
      });
      return;
    }

    const existing = await context.V4PoolState.get(poolId);
    if (!existing) return;

    v4MetaCache.set(poolId, { tickSpacing: existing.tickSpacing, hooks: existing.hooks });

    context.V4PoolState.set({
      id: poolId,
      address: poolId,
      lastUpdatedBlock: Number(event.block.number),
      sqrtPriceX96: event.params.sqrtPriceX96,
      liquidity: event.params.liquidity,
      tick: Number(event.params.tick),
      fee: event.params.fee,
      tickSpacing: existing.tickSpacing,
      hooks: existing.hooks,
    });
  },
);
