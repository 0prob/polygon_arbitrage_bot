import { indexer } from "envio";
import { fetchTokenMeta } from "../effects/token_metadata";
import { logEffectTime } from "../utils/instrumentation";
import { setTokenMetasIfMissing } from "../utils/entity_writes";

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
    const blockNumber = Number(event.block.number);
    const txHash = event.transaction?.hash;

    // Schedule ALL effects early (before any sets/caches) so they participate
    // in Envio V3 preload batching + memoization across the event batch.
    // See: https://docs.envio.dev/docs/HyperIndex/preload-optimization
    //
    // Bounded concurrency when HYPERSYNC_RPM_TARGET low.
    const tEff0 = Date.now();
    const [c0meta, c1meta] = await Promise.all([
      context.effect(fetchTokenMeta, { address: currency0 }),
      context.effect(fetchTokenMeta, { address: currency1 }),
    ]);
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

    // Hot V4 state comes from arb bot RPC — skip V4PoolState DB write.
    await setTokenMetasIfMissing(context, [currency0, currency1], [c0meta.decimals, c1meta.decimals]);
  },
);

/** Swap — intentional no-op; hot V4 state comes from arb bot RPC. */
indexer.onEvent({ contract: "PoolManager", event: "Swap" }, async () => {});
