import { indexer } from "envio";

/**
 * Curve Pool Event Handlers
 *
 * Optimizations applied (Envio v3 Best Practices):
 * 1. Preload Optimization: Batched database reads (CurvePoolState) are executed
 *    in Phase 1 (Preload).
 * 2. Early Exit: Exit early on `context.isPreload === true` to prevent any writes in the preload phase.
 * 3. Consistently lowercased addressing is automatically supported via address_format: lowercase in config.yaml.
 */
indexer.onEvent({ contract: "CurvePool", event: "TokenExchange" }, async ({ event, context }) => {
  const pool = event.srcAddress;
  const state = await context.CurvePoolState.get(pool);
  if (!state) return;

  if (context.isPreload) return;

  const sold_id = Number(event.params.sold_id);
  const bought_id = Number(event.params.bought_id);
  const balances = [...state.balances];

  if (balances[sold_id] != null) balances[sold_id] += event.params.tokens_sold;
  if (balances[bought_id] != null) balances[bought_id] -= event.params.tokens_bought;

  context.CurvePoolState.set({
    ...state,
    lastUpdatedBlock: Number(event.block.number),
    balances,
  });
});

indexer.onEvent({ contract: "CurvePool", event: "AddLiquidity" }, async ({ event, context }) => {
  const pool = event.srcAddress;
  const state = await context.CurvePoolState.get(pool);
  if (!state) return;

  if (context.isPreload) return;

  const balances = [...state.balances];
  const amounts = event.params.token_amounts;

  for (let i = 0; i < balances.length; i++) {
    balances[i] += amounts[i] || 0n;
  }

  context.CurvePoolState.set({
    ...state,
    lastUpdatedBlock: Number(event.block.number),
    balances,
  });
});

indexer.onEvent({ contract: "CurvePool", event: "RemoveLiquidity" }, async ({ event, context }) => {
  const pool = event.srcAddress;
  const state = await context.CurvePoolState.get(pool);
  if (!state) return;

  if (context.isPreload) return;

  const balances = [...state.balances];
  const amounts = event.params.token_amounts;

  for (let i = 0; i < balances.length; i++) {
    balances[i] -= amounts[i] || 0n;
  }

  context.CurvePoolState.set({
    ...state,
    lastUpdatedBlock: Number(event.block.number),
    balances,
  });
});

indexer.onEvent({ contract: "CurvePool", event: "RemoveLiquidityOne" }, async ({ event, context }) => {
  const pool = event.srcAddress;
  const state = await context.CurvePoolState.get(pool);
  if (!state) return;

  if (context.isPreload) return;

  const balances = [...state.balances];
  const idx = Number(event.params.coin_index);
  if (balances[idx] != null) {
    balances[idx] -= event.params.coin_amount;
  }

  context.CurvePoolState.set({
    ...state,
    lastUpdatedBlock: Number(event.block.number),
    balances,
  });
});
