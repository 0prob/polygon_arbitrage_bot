import { indexer } from "envio";

const curveMetaCache = new Map<string, {
  A: bigint;
  fee: bigint;
  rates: bigint[] | undefined;
}>();

indexer.onEvent(
  { contract: "CurvePool", event: "TokenExchange" },
  async ({ event, context }) => {
    const pool = event.srcAddress.toLowerCase();
    const state = await context.CurvePoolState.get(pool);
    if (!state) return;

    const balances = [...state.balances];
    const soldId = Number(event.params.sold_id);
    const boughtId = Number(event.params.bought_id);

    if (soldId < balances.length) balances[soldId] = BigInt(balances[soldId]) + BigInt(event.params.tokens_sold);
    if (boughtId < balances.length) balances[boughtId] = BigInt(balances[boughtId]) - BigInt(event.params.tokens_bought);

    const cached = curveMetaCache.get(pool);
    if (cached) {
      context.CurvePoolState.set({
        id: pool,
        address: pool,
        lastUpdatedBlock: Number(event.block.number),
        balances,
        ...cached,
      });
      return;
    }

    curveMetaCache.set(pool, { A: state.A, fee: state.fee, rates: state.rates ? [...state.rates] : undefined });

    context.CurvePoolState.set({
      ...state,
      lastUpdatedBlock: Number(event.block.number),
      balances,
    });
  },
);

indexer.onEvent(
  { contract: "CurvePool", event: "AddLiquidity" },
  async ({ event, context }) => {
    const pool = event.srcAddress.toLowerCase();
    const state = await context.CurvePoolState.get(pool);
    if (!state) return;

    const balances = [...state.balances];
    const added = event.params.token_amounts;

    for (let i = 0; i < balances.length && i < added.length; i++) {
      balances[i] = BigInt(balances[i]) + BigInt(added[i]);
    }

    const cached = curveMetaCache.get(pool);
    if (cached) {
      context.CurvePoolState.set({
        id: pool,
        address: pool,
        lastUpdatedBlock: Number(event.block.number),
        balances,
        ...cached,
      });
      return;
    }

    curveMetaCache.set(pool, { A: state.A, fee: state.fee, rates: state.rates ? [...state.rates] : undefined });

    context.CurvePoolState.set({
      ...state,
      lastUpdatedBlock: Number(event.block.number),
      balances,
    });
  },
);

indexer.onEvent(
  { contract: "CurvePool", event: "RemoveLiquidity" },
  async ({ event, context }) => {
    const pool = event.srcAddress.toLowerCase();
    const state = await context.CurvePoolState.get(pool);
    if (!state) return;

    const balances = [...state.balances];
    const removed = event.params.token_amounts;

    for (let i = 0; i < balances.length && i < removed.length; i++) {
      balances[i] = BigInt(balances[i]) - BigInt(removed[i]);
    }

    const cached = curveMetaCache.get(pool);
    if (cached) {
      context.CurvePoolState.set({
        id: pool,
        address: pool,
        lastUpdatedBlock: Number(event.block.number),
        balances,
        ...cached,
      });
      return;
    }

    curveMetaCache.set(pool, { A: state.A, fee: state.fee, rates: state.rates ? [...state.rates] : undefined });

    context.CurvePoolState.set({
      ...state,
      lastUpdatedBlock: Number(event.block.number),
      balances,
    });
  },
);

indexer.onEvent(
  { contract: "CurvePool", event: "RemoveLiquidityOne" },
  async ({ event, context }) => {
    const pool = event.srcAddress.toLowerCase();
    const state = await context.CurvePoolState.get(pool);
    if (!state) return;

    const balances = [...state.balances];
    const coinIndex = Number(event.params.coin_index);
    if (coinIndex < balances.length) {
      balances[coinIndex] = BigInt(balances[coinIndex]) - BigInt(event.params.coin_amount);
    }

    const cached = curveMetaCache.get(pool);
    if (cached) {
      context.CurvePoolState.set({
        id: pool,
        address: pool,
        lastUpdatedBlock: Number(event.block.number),
        balances,
        ...cached,
      });
      return;
    }

    curveMetaCache.set(pool, { A: state.A, fee: state.fee, rates: state.rates ? [...state.rates] : undefined });

    context.CurvePoolState.set({
      ...state,
      lastUpdatedBlock: Number(event.block.number),
      balances,
    });
  },
);
