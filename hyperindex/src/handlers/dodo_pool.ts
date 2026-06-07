import { indexer } from "envio";

/**
 * DODO Pool Sync Event Handler
 *
 * Optimizations applied (Envio v3 Best Practices):
 * 1. Preload Optimization: Batched database reads (DodoPoolState) are executed
 *    in Phase 1 (Preload).
 * 2. Early Exit: Exit early on `context.isPreload === true` to prevent any writes in the preload phase.
 * 3. Consistently lowercased addressing is automatically supported via address_format: lowercase in config.yaml.
 */
indexer.onEvent({ contract: "DodoPool", event: "Sync" }, async ({ event, context }) => {
  const poolAddr = event.srcAddress;
  const existing = await context.DodoPoolState.get(poolAddr);
  if (!existing) return;

  // Skip writes during preload phase
  if (context.isPreload) return;

  context.DodoPoolState.set({
    ...existing,
    lastUpdatedBlock: Number(event.block.number),
    baseReserve: event.params.reserve0,
    quoteReserve: event.params.reserve1,
  });
});
