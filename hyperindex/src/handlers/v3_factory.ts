import { indexer } from "envio";
import { fetchTokenMeta } from "../effects/token_metadata";
import { createHotBiasWhere, INDEXER_HOT_BIAS } from "../utils/hot_tokens";
import { logEffectTime } from "../utils/instrumentation";
import { getMetadataConcurrency, runWithConcurrency } from "../utils/pacing";

// Envio v3: context.chain and the global `indexer` object give typed access to
// both static config and dynamically registered addresses (survives restarts).

const FACTORY_PROTOCOLS: Record<string, string> = {
  "0x1f98431c8ad98523631ae4a59f267346ea31f984": "UNISWAP_V3",
  "0x917933899c6a5f8e37f31e19f92cdbff7e8ff0e2": "SUSHISWAP_V3",
  "0x411b0facc3489691f28ad58c47006af5e3ab3a28": "QUICKSWAP_V3",
  "0x5f1dddbf348ac2fbe22a163e30f99f9ece3dd50a": "KYBERSWAP_ELASTIC",
};

indexer.contractRegister(
  {
    contract: "V3Factory",
    event: "PoolCreated",
    where: createHotBiasWhere(INDEXER_HOT_BIAS),
  },
  async ({ event, context }) => {
    context.chain.UniswapV3Pool.add(event.params.pool);

    if (context.log) {
      context.log.info("Registered dynamic V3 pool", { pool: event.params.pool });
    }
  },
);

indexer.onEvent(
  {
    contract: "V3Factory",
    event: "PoolCreated",
    where: createHotBiasWhere(INDEXER_HOT_BIAS),
  },
  async ({ event, context }) => {
    const t0 = event.params.token0;
    const t1 = event.params.token1;

    const factoryAddr = event.srcAddress;

    if (t0 === factoryAddr || t1 === factoryAddr) {
      return;
    }

    const protocol = FACTORY_PROTOCOLS[factoryAddr] ?? "UNKNOWN_V3";
    const poolAddr = event.params.pool;
    const blockNumber = Number(event.block.number);

    // Effects first (before any sets) for preload batching. PoolMeta set moved post-guard.
    // Concurrency is reduced automatically when HYPERSYNC_RPM_TARGET is low.
    const tEff0 = Date.now();
    const concurrency = getMetadataConcurrency();
    const [t0meta, t1meta] = await runWithConcurrency(
      [t0, t1],
      concurrency,
      (addr) => context.effect(fetchTokenMeta, { address: addr })
    );
    logEffectTime("fetchTokenMeta:pool", Date.now() - tEff0, blockNumber);

    if (context.isPreload) {
      return;
    }

    context.PoolMeta.set({
      id: poolAddr,
      address: poolAddr,
      protocol: protocol as any,
      tokens: [t0, t1],
      fee: Number(event.params.fee),
      tickSpacing: Number(event.params.tickSpacing),
      createdBlock: blockNumber,
      createdTx: event.transaction.hash,
      poolId: undefined,
    });

    context.TokenMeta.set({ id: t0, address: t0, decimals: t0meta.decimals });
    context.TokenMeta.set({ id: t1, address: t1, decimals: t1meta.decimals });
  },
);
