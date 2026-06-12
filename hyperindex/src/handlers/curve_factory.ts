import { indexer } from "envio";
import { fetchCurveMetadata } from "../effects/curve_metadata";
import { fetchTokenMeta } from "../effects/token_metadata";
import { logEffectTime } from "../utils/instrumentation";
import { getMetadataConcurrency, runWithConcurrency } from "../utils/pacing";

// Modern v3 async contractRegister with conditional logic + external call.
// Per the dynamic-contracts guide, we can do effects here to decide whether
// to register a pool at all. Under hot bias we skip cold Curve pools entirely
// (avoiding delivery of all their future TokenExchange etc. events).
// See https://docs.envio.dev/docs/HyperIndex/dynamic-contracts#async-contract-register
indexer.contractRegister({ contract: "CurveRegistry", event: "PoolAdded" }, async ({ event, context }) => {
  const pool = event.params.pool;

  context.chain.CurvePool.add(pool);

  if (context.log) {
    context.log.info("Registered dynamic Curve pool", { pool });
  }
});

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
    const meta = await context.effect(fetchCurveMetadata, { pool, nCoins: 8, blockNumber: BigInt(blockNumber) });
    logEffectTime("fetchCurveMetadata", Date.now() - tEffCurve, blockNumber);

    const ZERO = "0x0000000000000000000000000000000000000000";
    const coins = meta.coins.filter((c) => c && c.toLowerCase() !== ZERO);
    if (coins.length < 2) return;

    const tEffCoins = Date.now();
    const concurrency = getMetadataConcurrency();
    const coinMetas = await runWithConcurrency(coins, concurrency, (coin) => context.effect(fetchTokenMeta, { address: coin }));
    logEffectTime("fetchTokenMeta:curveCoins", Date.now() - tEffCoins, blockNumber);

    if (context.isPreload) {
      return;
    }

    // Curve fee(): 1e10 = 100% → bps = fee / 1e6
    const feeBps = meta.fee > 0n ? Number(meta.fee / 1_000_000n) : 4;

    context.PoolMeta.set({
      id: pool,
      address: pool,
      protocol: "CURVE",
      tokens: coins,
      fee: feeBps > 0 ? feeBps : 4,
      tickSpacing: undefined,
      createdBlock: blockNumber,
      createdTx: event.transaction.hash,
      poolId: undefined,
    });

    context.CurvePoolState.set({
      id: pool,
      address: pool,
      lastUpdatedBlock: blockNumber,
      balances: meta.balances.slice(0, coins.length),
      A: meta.A,
      fee: meta.fee,
      rates: meta.rates.slice(0, coins.length),
    });

    coins.forEach((coin, i) => {
      context.TokenMeta.set({ id: coin, address: coin, decimals: coinMetas[i].decimals });
    });
  },
);
