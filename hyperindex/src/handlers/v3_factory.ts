import { indexer } from "envio";
import { fetchTokenMeta } from "../effects/token_metadata";
import { shouldSkipFactoryPool } from "../utils/guards";
import { setTokenMetasIfMissing } from "../utils/entity_writes";

type Protocol =
  | "UNISWAP_V2"
  | "SUSHISWAP_V2"
  | "QUICKSWAP_V2"
  | "DFYN_V2"
  | "APESWAP_V2"
  | "MESHSWAP_V2"
  | "JETSWAP_V2"
  | "COMETHSWAP_V2"
  | "UNISWAP_V3"
  | "SUSHISWAP_V3"
  | "QUICKSWAP_V3"
  | "KYBERSWAP_ELASTIC"
  | "CURVE"
  | "BALANCER_V2"
  | "DODO_V2"
  | "UNISWAP_V4"
  | "UNKNOWN_V2"
  | "UNKNOWN_V3";

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
  },
  async ({ event, context }) => {
    const t0 = event.params.token0;
    const t1 = event.params.token1;
    if (shouldSkipFactoryPool(t0, t1, event.srcAddress)) return;

    context.chain.UniswapV3Pool.add(event.params.pool);
  },
);

indexer.onEvent(
  {
    contract: "V3Factory",
    event: "PoolCreated",
  },
  async ({ event, context }) => {
    const t0 = event.params.token0;
    const t1 = event.params.token1;

    const factoryAddr = event.srcAddress;

    // Consistency: skip obvious garbage pairs (zero address, factory-as-token, etc.)
    if (shouldSkipFactoryPool(t0, t1, factoryAddr)) {
      return;
    }

    const protocol = FACTORY_PROTOCOLS[factoryAddr] ?? "UNKNOWN_V3";
    const poolAddr = event.params.pool;
    const blockNumber = Number(event.block.number);

    // Effects first (before any sets) for preload batching. PoolMeta set moved post-guard.
    // Concurrency is reduced automatically when HYPERSYNC_RPM_TARGET is low.
    const [t0meta, t1meta] = await Promise.all([
      context.effect(fetchTokenMeta, { address: t0 }),
      context.effect(fetchTokenMeta, { address: t1 }),
    ]);

    if (context.isPreload) {
      return;
    }

    context.PoolMeta.set({
      id: poolAddr,
      address: poolAddr,
      protocol: protocol as Protocol,
      tokens: [t0, t1],
      fee: Number(event.params.fee),
      tickSpacing: Number(event.params.tickSpacing),
      createdBlock: blockNumber,
      createdTx: event.transaction.hash,
      poolId: undefined,
    });

    await setTokenMetasIfMissing(context, [t0, t1], [t0meta.decimals, t1meta.decimals]);
  },
);
