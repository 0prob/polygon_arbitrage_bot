import { indexer } from "envio";
import { fetchTokenMeta } from "../effects/token_metadata";
import { isLikelyGarbagePair, createHotBiasWhere, INDEXER_HOT_BIAS } from "../utils/hot_tokens";

// Envio v3 best practice: Use the global `indexer` object (or context.chain inside handlers)
// to access live configuration and dynamically registered addresses (persisted across restarts).

const FACTORY_PROTOCOLS: Record<string, { protocol: string; feeBps: number }> = {
  "0x5757371414417b8c6caad45baef941abc7d3ab32": { protocol: "quickswap_v2", feeBps: 30 },
  "0xc35dadb65012ec5796536bd9864ed8773abc74c4": { protocol: "sushiswap_v2", feeBps: 25 },
  "0x9e5a52f57b3038f1b8eee45f28b3c1967e22799c": { protocol: "uniswap_v2", feeBps: 30 },
  "0xe7fb3e833efe5f9c441105eb65ef8b261266423b": { protocol: "dfyn_v2", feeBps: 30 },
  "0xcf083be4164828f00cae704ec15a36d711491284": { protocol: "apeswap_v2", feeBps: 20 },
  "0x9f3044f7f9fc8bc9ed615d54845b4577b833282d": { protocol: "meshswap_v2", feeBps: 30 },
  "0x668ad0ed2622c62e24f0d5ab6b6ac1b9d2cd4ac7": { protocol: "jetswap_v2", feeBps: 20 },
  "0x800b052609c355ca8103e06f022aa30647ead60a": { protocol: "comethswap_v2", feeBps: 30 },
};

// Envio v3 pattern: contractRegister can take a `where` filter for early topic-level rejection.
// This is the highest-ROI optimization for high-volume factory events on Polygon.
indexer.contractRegister(
  {
    contract: "V2Factory",
    event: "PairCreated",
    where: createHotBiasWhere(INDEXER_HOT_BIAS),
  },
  async ({ event, context }) => {
    // Use context.chain for the modern v3 way to register dynamic contracts.
    context.chain.UniswapV2Pool.add(event.params.pair);
  },
);

indexer.onEvent(
  {
    contract: "V2Factory",
    event: "PairCreated",
    where: createHotBiasWhere(INDEXER_HOT_BIAS),
  },
  async ({ event, context }) => {
    const t0 = event.params.token0.toLowerCase();
    const t1 = event.params.token1.toLowerCase();

    const factoryAddr = event.srcAddress.toLowerCase();

    // JS-level defensive filter using shared hot_tokens (kept in sync with root bot).
    // This complements any where topic filtering.
    if (t0 === factoryAddr || t1 === factoryAddr || isLikelyGarbagePair(t0, t1)) {
      return;
    }

    const info = FACTORY_PROTOCOLS[factoryAddr] ?? { protocol: "unknown_v2", feeBps: 30 };

    context.PoolMeta.set({
      id: event.params.pair.toLowerCase(),
      address: event.params.pair.toLowerCase(),
      protocol: info.protocol,
      tokens: [t0, t1],
      fee: info.feeBps,
      tickSpacing: undefined,
      createdBlock: Number(event.block.number),
      createdTx: event.transaction.hash,
      poolId: undefined,
    });

    // Envio v3 Preload + Effect API best practice.
    const [t0meta, t1meta] = await Promise.all([
      context.effect(fetchTokenMeta, { address: t0, blockNumber: BigInt(event.block.number) }),
      context.effect(fetchTokenMeta, { address: t1, blockNumber: BigInt(event.block.number) }),
    ]);

    // Aggressive isPreload: after effects (which preload batches), exit early in preload phase.
    // Sets below will only execute (and persist) in the real processing phase.
    // This avoids any unnecessary work during the optimistic preload pass.
    if (context.isPreload) {
      return;
    }

    context.TokenMeta.set({ id: t0, address: t0, decimals: t0meta.decimals });
    context.TokenMeta.set({ id: t1, address: t1, decimals: t1meta.decimals });
  },
);
