import { indexer } from "envio";

/**
 * Uniswap V2 Pool Sync Event Handler
 *
 * Optimizations applied (Envio v3 Best Practices):
 * 1. Preload Optimization: Batched database reads (V2PoolState and PoolMeta) are executed
 *    concurrently using Promise.all in Phase 1 (Preload).
 * 2. Early Exit: Exit early on `context.isPreload === true` to prevent any writes in the preload phase.
 * 3. Consistently lowercased addressing is automatically supported via address_format: lowercase in config.yaml.
 */
indexer.onEvent(
  {
    contract: "UniswapV2Pool",
    event: "Sync",
  },
  async ({ event, context }) => {
    const poolAddr = event.srcAddress;

    // Concurrently fetch V2 pool state and pool metadata in preload pass.
    const [existing, meta] = await Promise.all([context.V2PoolState.get(poolAddr), context.PoolMeta.get(poolAddr)]);

    // Skip writes during preload phase
    if (context.isPreload) return;

    context.V2PoolState.set({
      id: poolAddr,
      address: poolAddr,
      lastUpdatedBlock: Number(event.block.number),
      reserve0: event.params.reserve0,
      reserve1: event.params.reserve1,
      fee: existing?.fee ?? meta?.fee ?? undefined,
    });
  },
);
