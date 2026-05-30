import { indexer } from "envio";
import { fetchDodoMetadata } from "../effects/dodo_metadata";
import { fetchTokenMeta } from "../effects/token_metadata";
import { createHotBiasWhere, INDEXER_HOT_BIAS } from "../utils/hot_tokens";
import { logEffectTime } from "../utils/instrumentation";

async function handleDodoPool(
  context: any,
  pool: string,
  base: string,
  quote: string,
  blockNumber: number,
  txHash: string | undefined,
) {
  context.PoolMeta.set({
    id: pool,
    address: pool,
    protocol: "dodo_v2",
    tokens: [base, quote],
    fee: 10,
    tickSpacing: undefined,
    createdBlock: blockNumber,
    createdTx: txHash,
    poolId: undefined,
  });

  // Fire DODO metadata + both token metas concurrently (critical for backfill throughput)
  const tEffDodo = Date.now();
  const [meta, baseMeta, quoteMeta] = await Promise.all([
    context.effect(fetchDodoMetadata, { pool, blockNumber: BigInt(blockNumber) }),
    context.effect(fetchTokenMeta, { address: base, blockNumber: BigInt(blockNumber) }),
    context.effect(fetchTokenMeta, { address: quote, blockNumber: BigInt(blockNumber) }),
  ]);
  logEffectTime("fetchDodoMetadata+tokens", Date.now() - tEffDodo, blockNumber);

  if (context.isPreload) {
    return; // Aggressive preload exit: effects done (batched), skip writes (ignored anyway) and any future work.
  }

  context.DodoPoolState.set({
    id: pool,
    address: pool,
    lastUpdatedBlock: blockNumber,
    baseReserve: meta.baseReserve,
    quoteReserve: meta.quoteReserve,
    targetBase: meta.baseTarget,
    targetQuote: meta.quoteTarget,
    rStatus: meta.rStatus,
    k: meta.k,
    fee: meta.fee,
    i: meta.i,
    lpFeeRate: meta.lpFeeRate,
    mtFeeRate: meta.mtFeeRate,
  });

  context.TokenMeta.set({ id: base, address: base, decimals: baseMeta.decimals });
  context.TokenMeta.set({ id: quote, address: quote, decimals: quoteMeta.decimals });
}

// Dynamic contract registration using Envio v3 patterns.
// See https://docs.envio.dev/docs/HyperIndex/dynamic-contracts
// We use the modern object form. `where` can be added for topic filtering on indexed params.
indexer.contractRegister(
  { contract: "DodoFactory", event: "DVMDeployed" },
  async ({ event, context }) => {
    context.chain.DodoPool.add(event.params.dvm);
  },
);

indexer.contractRegister(
  { contract: "DodoFactory", event: "DPPDeployed" },
  async ({ event, context }) => {
    context.chain.DodoPool.add(event.params.dpp);
  },
);

indexer.contractRegister(
  { contract: "DodoFactory", event: "DSPDeployed" },
  async ({ event, context }) => {
    context.chain.DodoPool.add(event.params.dsp);
  },
);

// DVM
indexer.onEvent(
  {
    contract: "DodoFactory",
    event: "DVMDeployed",
    where: createHotBiasWhere(INDEXER_HOT_BIAS, ["baseToken", "quoteToken"]),
  },
  async ({ event, context }) => {
    await handleDodoPool(
      context,
      event.params.dvm.toLowerCase(),
      event.params.baseToken.toLowerCase(),
      event.params.quoteToken.toLowerCase(),
      Number(event.block.number),
      event.transaction.hash,
    );
    if (context.isPreload) return;
  },
);

// DPP
indexer.onEvent(
  {
    contract: "DodoFactory",
    event: "DPPDeployed",
    where: createHotBiasWhere(INDEXER_HOT_BIAS, ["baseToken", "quoteToken"]),
  },
  async ({ event, context }) => {
    await handleDodoPool(
      context,
      event.params.dpp.toLowerCase(),
      event.params.baseToken.toLowerCase(),
      event.params.quoteToken.toLowerCase(),
      Number(event.block.number),
      event.transaction.hash,
    );
    if (context.isPreload) return;
  },
);

// DSP
indexer.onEvent(
  {
    contract: "DodoFactory",
    event: "DSPDeployed",
    where: createHotBiasWhere(INDEXER_HOT_BIAS, ["baseToken", "quoteToken"]),
  },
  async ({ event, context }) => {
    await handleDodoPool(
      context,
      event.params.dsp.toLowerCase(),
      event.params.baseToken.toLowerCase(),
      event.params.quoteToken.toLowerCase(),
      Number(event.block.number),
      event.transaction.hash,
    );
    if (context.isPreload) return;
  },
);
