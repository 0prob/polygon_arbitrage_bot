import { indexer } from "envio";
import { fetchTokenMeta } from "../effects/token_metadata";
import { createHotBiasWhere, INDEXER_HOT_BIAS } from "../utils/hot_tokens";

const v4MetaCache = new Map<string, { tickSpacing: number; hooks: string }>();

indexer.onEvent(
  {
    contract: "PoolManager",
    event: "Initialize",
    where: createHotBiasWhere(INDEXER_HOT_BIAS, ["currency0", "currency1"]),
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
    const [c0meta, c1meta] = await Promise.all([
      context.effect(fetchTokenMeta, { address: currency0, blockNumber: BigInt(blockNumber) }),
      context.effect(fetchTokenMeta, { address: currency1, blockNumber: BigInt(blockNumber) }),
    ]);

    if (context.isPreload) {
      return;
    }

    v4MetaCache.set(poolId, { tickSpacing, hooks });

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

indexer.onEvent(
  { contract: "PoolManager", event: "Swap" },
  async () => {
    // No-op for live debug indexer.
    // V4 Swap events no longer write V4PoolState (removes repeated DB writes).
    // Initialize (above) still writes creation-time state — acceptable volume.
  },
);
