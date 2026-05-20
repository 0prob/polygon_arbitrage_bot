import { indexer } from "envio";

indexer.onEvent(
  { contract: "CurvePool", event: "TokenExchange" },
  async ({ event, context }: any) => {
    const pool = event.srcAddress.toLowerCase();
    const state = await context.CurvePoolState.get(pool);
    if (!state) return;

    const balances = [...state.balances];
    const soldId = Number(event.params.sold_id);
    const boughtId = Number(event.params.bought_id);

    if (soldId < balances.length) balances[soldId] += event.params.tokens_sold;
    if (boughtId < balances.length) balances[boughtId] -= event.params.tokens_bought;

    context.CurvePoolState.set({
      ...state,
      lastUpdatedBlock: Number(event.block.number),
      balances,
    });
  },
);

indexer.onEvent(
  { contract: "CurvePool", event: "AddLiquidity" },
  async ({ event, context }: any) => {
    const pool = event.srcAddress.toLowerCase();
    const state = await context.CurvePoolState.get(pool);
    if (!state) return;

    const balances = [...state.balances];
    const added = event.params.token_amounts;

    for (let i = 0; i < balances.length && i < added.length; i++) {
      balances[i] += added[i];
    }

    context.CurvePoolState.set({
      ...state,
      lastUpdatedBlock: Number(event.block.number),
      balances,
    });
  },
);

indexer.onEvent(
  { contract: "CurvePool", event: "RemoveLiquidity" },
  async ({ event, context }: any) => {
    const pool = event.srcAddress.toLowerCase();
    const state = await context.CurvePoolState.get(pool);
    if (!state) return;

    const balances = [...state.balances];
    const removed = event.params.token_amounts;

    for (let i = 0; i < balances.length && i < removed.length; i++) {
      balances[i] -= removed[i];
    }

    context.CurvePoolState.set({
      ...state,
      lastUpdatedBlock: Number(event.block.number),
      balances,
    });
  },
);
