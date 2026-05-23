import { indexer } from "envio";
import { fetchCurveMetadata } from "../effects/curve_metadata";
import { fetchTokenMeta } from "../effects/token_metadata";

indexer.contractRegister(
  { contract: "CurveRegistry", event: "PoolAdded" },
  async ({ event, context }) => {
    context.chain.CurvePool.add(event.params.pool);
  },
);

indexer.onEvent(
  { contract: "CurveRegistry", event: "PoolAdded" },
  async ({ event, context }) => {
    const pool = event.params.pool.toLowerCase();
    const existing = await context.PoolMeta.get(pool);
    if (existing) return;

    if (context.isPreload) {
      context.PoolMeta.set({
        id: pool,
        address: pool,
        protocol: "curve",
        tokens: [],
        fee: 1,
        tickSpacing: undefined,
        createdBlock: Number(event.block.number),
        createdTx: event.transaction.hash,
        poolId: undefined,
      });
      return;
    }

    const meta = await context.effect(fetchCurveMetadata, { pool, nCoins: 4 });

    const feeBps = meta.fee > 0n ? Number(meta.fee / 10n ** 16n) : 1;

    context.PoolMeta.set({
      id: pool,
      address: pool,
      protocol: "curve",
      tokens: meta.coins,
      fee: feeBps,
      tickSpacing: undefined,
      createdBlock: Number(event.block.number),
      createdTx: event.transaction.hash,
      poolId: undefined,
    });

    context.CurvePoolState.set({
      id: pool,
      address: pool,
      lastUpdatedBlock: Number(event.block.number),
      balances: meta.balances,
      A: meta.A,
      fee: meta.fee,
    });

    for (const coin of meta.coins) {
      const coinMeta = await context.effect(fetchTokenMeta, { address: coin });
      context.TokenMeta.set({ id: coin, address: coin, decimals: coinMeta.decimals });
    }
  },
);
