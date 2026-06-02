import { indexer } from "envio";
import { fetchCurveMetadata } from "../effects/curve_metadata";
import { fetchTokenMeta } from "../effects/token_metadata";
import { involvesHotBase, INDEXER_HOT_BIAS } from "../utils/hot_tokens";
import { logEffectTime } from "../utils/instrumentation";
import { getMetadataConcurrency, runWithConcurrency } from "../utils/pacing";

// Modern v3 async contractRegister with conditional logic + external call.
// Per the dynamic-contracts guide, we can do effects here to decide whether
// to register a pool at all. Under hot bias we skip cold Curve pools entirely
// (avoiding delivery of all their future TokenExchange etc. events).
// See https://docs.envio.dev/docs/HyperIndex/dynamic-contracts#async-contract-register
indexer.contractRegister(
  { contract: "CurveRegistry", event: "PoolAdded" },
  async ({ event, context }) => {
    const pool = event.params.pool;

    // For hot bias mode we need the coins to decide — fetch early via Effect API
    // (batching + memoization still applies across the batch of factory events).
    if (INDEXER_HOT_BIAS) {
      const meta = await context.effect(fetchCurveMetadata, {
        pool,
        nCoins: 4,
        blockNumber: BigInt(Number(event.block.number)),
      });

      if (!meta.coins.some((coin) => involvesHotBase(coin, coin))) {
        // Cold pool under hot bias — do not register. Future pool events will be ignored.
        return;
      }
    }

    context.chain.CurvePool.add(pool);

    if (context.log) {
      context.log.info("Registered dynamic Curve pool", { pool });
    }
  },
);

indexer.onEvent(
  {
    contract: "CurveRegistry",
    event: "PoolAdded",
  },
  async ({ event, context }) => {
    const pool = event.params.pool;
    const blockNumber = Number(event.block.number);

    // Envio v3 preload best practice: do reads early so they are batched.
    const existing = await context.PoolMeta.get(pool);
    if (existing) return;

    const tEffCurve = Date.now();
    const meta = await context.effect(fetchCurveMetadata, { pool, nCoins: 4, blockNumber: BigInt(blockNumber) });
    logEffectTime("fetchCurveMetadata", Date.now() - tEffCurve, blockNumber);

    // Hot bias filtering for Curve now primarily happens in the async contractRegister
    // (see above). This remains as a backstop / for the non-hot-bias case.
    if (INDEXER_HOT_BIAS && !meta.coins.some((coin) => involvesHotBase(coin, coin))) {
      return;
    }

    // Schedule + await coin token metadata effects *early* (right after curve meta, before isPreload guard)
    // so the full set of effects for this event participates in preload-phase parallel batching
    // and memoization (critical for backfill). See docs.envio.dev/docs/HyperIndex/preload-optimization
    //
    // Concurrency is capped when HYPERSYNC_RPM_TARGET is low to keep request patterns smooth.
    const tEffCoins = Date.now();
    const concurrency = getMetadataConcurrency();
    const coinMetas = await runWithConcurrency(
      meta.coins,
      concurrency,
      (coin) => context.effect(fetchTokenMeta, { address: coin, blockNumber: BigInt(blockNumber) })
    );
    logEffectTime("fetchTokenMeta:curveCoins", Date.now() - tEffCoins, blockNumber);

    if (context.isPreload) {
      return;
    }

    const feeBps = meta.fee > 0n ? Number(meta.fee / 10n ** 16n) : 1;

    context.PoolMeta.set({
      id: pool,
      address: pool,
      protocol: "CURVE",
      tokens: meta.coins,
      fee: feeBps,
      tickSpacing: undefined,
      createdBlock: blockNumber,
      createdTx: event.transaction.hash,
      poolId: undefined,
    });

    context.CurvePoolState.set({
      id: pool,
      address: pool,
      lastUpdatedBlock: blockNumber,
      balances: meta.balances,
      A: meta.A,
      fee: meta.fee,
      rates: meta.rates,
    });

    meta.coins.forEach((coin, i) => {
      context.TokenMeta.set({ id: coin, address: coin, decimals: coinMetas[i].decimals });
    });
  },
);
