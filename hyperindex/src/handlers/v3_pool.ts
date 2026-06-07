import { indexer } from "envio";

/**
 * Uniswap V3 Pool Event Handlers
 *
 * Optimizations applied (Envio v3 Best Practices):
 * 1. Preload Optimization: Batched database reads (V3PoolState and PoolMeta) are executed
 *    concurrently using Promise.all in Phase 1 (Preload).
 * 2. Early Exit: Exit early on `context.isPreload === true` to prevent any writes in the preload phase.
 * 3. Consistently lowercased addressing is automatically supported via address_format: lowercase in config.yaml.
 */
indexer.onEvent({ contract: "UniswapV3Pool", event: "Initialize" }, async ({ event, context }) => {
  const poolAddr = event.srcAddress;

  // Concurrently fetch V3 pool state and pool metadata in preload pass.
  const [existing, meta] = await Promise.all([context.V3PoolState.get(poolAddr), context.PoolMeta.get(poolAddr)]);

  // Skip writes during preload phase
  if (context.isPreload) return;

  context.V3PoolState.set({
    id: poolAddr,
    address: poolAddr,
    lastUpdatedBlock: Number(event.block.number),
    sqrtPriceX96: event.params.sqrtPriceX96,
    liquidity: existing?.liquidity ?? 0n,
    tick: Number(event.params.tick),
    fee: existing?.fee ?? meta?.fee ?? undefined,
    tickSpacing: existing?.tickSpacing ?? meta?.tickSpacing ?? undefined,
  });
});

indexer.onEvent({ contract: "UniswapV3Pool", event: "Swap" }, async ({ event, context }) => {
  const poolAddr = event.srcAddress;

  // Concurrently fetch V3 pool state and pool metadata in preload pass.
  const [existing, meta] = await Promise.all([context.V3PoolState.get(poolAddr), context.PoolMeta.get(poolAddr)]);

  // Skip writes during preload phase
  if (context.isPreload) return;

  context.V3PoolState.set({
    id: poolAddr,
    address: poolAddr,
    lastUpdatedBlock: Number(event.block.number),
    sqrtPriceX96: event.params.sqrtPriceX96,
    liquidity: event.params.liquidity,
    tick: Number(event.params.tick),
    fee: existing?.fee ?? meta?.fee ?? undefined,
    tickSpacing: existing?.tickSpacing ?? meta?.tickSpacing ?? undefined,
  });
});
