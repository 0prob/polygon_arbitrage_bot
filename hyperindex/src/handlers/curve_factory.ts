import { indexer } from "envio";
import { fetchCurveMetadata } from "../effects/curve_metadata";
import { fetchTokenMeta } from "../effects/token_metadata";
import { createHotBiasWhere, INDEXER_HOT_BIAS } from "../utils/hot_tokens";

// Modern v3 contractRegister form (supports `where` for early filtering on indexed params).
indexer.contractRegister(
  { contract: "CurveRegistry", event: "PoolAdded" },
  async ({ event, context }) => {
    context.chain.CurvePool.add(event.params.pool);
  },
);

indexer.onEvent(
  {
    contract: "CurveRegistry",
    event: "PoolAdded",
    where: createHotBiasWhere(INDEXER_HOT_BIAS, ["pool", "pool"]),
  },
  async ({ event, context }) => {
    const pool = event.params.pool.toLowerCase();

    // Envio v3 preload best practice: do reads early so they are batched.
    const existing = await context.PoolMeta.get(pool);
    if (existing) return;

    const meta = await context.effect(fetchCurveMetadata, { pool, nCoins: 4, blockNumber: BigInt(event.block.number) });

    if (context.isPreload) {
      return;
    }

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
      rates: meta.rates,
    });

    // Parallelize token metadata fetches (critical for backfill speed per Envio preload guidance)
    const coinMetas = await Promise.all(
      meta.coins.map((coin) =>
        context.effect(fetchTokenMeta, {
          address: coin,
          blockNumber: BigInt(event.block.number),
        })
      )
    );
    meta.coins.forEach((coin, i) => {
      context.TokenMeta.set({ id: coin, address: coin, decimals: coinMetas[i].decimals });
    });
  },
);
