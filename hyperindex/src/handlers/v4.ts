import { indexer } from "envio";
import { fetchTokenMeta } from "../effects/token_metadata";
import { logEffectTime } from "../utils/instrumentation";
import { getMetadataConcurrency, runWithConcurrency } from "../utils/pacing";

indexer.onEvent(
  {
    contract: "PoolManager",
    event: "Initialize",
  },
  async ({ event, context }) => {
    const poolId = event.params.id;
    const currency0 = event.params.currency0;
    const currency1 = event.params.currency1;
    const tickSpacing = Number(event.params.tickSpacing);
    const hooks = event.params.hooks;
    const blockNumber = Number(event.block.number);
    const txHash = event.transaction?.hash;

    // Schedule ALL effects early (before any sets/caches) so they participate
    // in Envio V3 preload batching + memoization across the event batch.
    // See: https://docs.envio.dev/docs/HyperIndex/preload-optimization
    //
    // Bounded concurrency when HYPERSYNC_RPM_TARGET low.
    const tEff0 = Date.now();
    const concurrency = getMetadataConcurrency();
    const [c0meta, c1meta] = await runWithConcurrency([currency0, currency1], concurrency, (addr) =>
      context.effect(fetchTokenMeta, { address: addr }),
    );
    logEffectTime("fetchTokenMeta:v4", Date.now() - tEff0, blockNumber);

    if (context.isPreload) {
      return;
    }

    context.PoolMeta.set({
      id: poolId,
      address: poolId,
      protocol: "UNISWAP_V4",
      tokens: [currency0, currency1],
      fee: Number(event.params.fee),
      tickSpacing,
      createdBlock: blockNumber,
      createdTx: txHash,
      poolId: undefined,
    });

    context.V4PoolState.set({
      id: poolId,
      address: poolId,
      lastUpdatedBlock: blockNumber,
      sqrtPriceX96: event.params.sqrtPriceX96,
      liquidity: 0n,
      tick: Number(event.params.tick),
      fee: event.params.fee,
      tickSpacing,
      hooks,
    });

    context.TokenMeta.set({ id: currency0, address: currency0, decimals: c0meta.decimals });
    context.TokenMeta.set({ id: currency1, address: currency1, decimals: c1meta.decimals });
  },
);

indexer.onEvent({ contract: "PoolManager", event: "Swap" }, async ({ event, context }) => {
  const poolId = event.params.id;
  const existing = await context.V4PoolState.get(poolId);
  if (!existing) return;

  if (context.isPreload) return;

  context.V4PoolState.set({
    ...existing,
    lastUpdatedBlock: Number(event.block.number),
    sqrtPriceX96: event.params.sqrtPriceX96,
    liquidity: event.params.liquidity,
    tick: Number(event.params.tick),
    fee: event.params.fee,
  });
});
