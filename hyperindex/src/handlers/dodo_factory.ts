import { indexer } from "envio";
import { fetchDodoMetadata } from "../effects/dodo_metadata";
import { fetchTokenMeta } from "../effects/token_metadata";
import { involvesHotBase, INDEXER_HOT_BIAS } from "../utils/hot_tokens";
import { logEffectTime } from "../utils/instrumentation";

async function handleDodoPool(
  context: any,
  pool: string,
  base: string,
  quote: string,
  blockNumber: number,
  txHash: string | undefined,
) {
  // Manual JS-level filter for hot bias mode because baseToken/quoteToken are not indexed
  if (INDEXER_HOT_BIAS && !involvesHotBase(base, quote)) {
    return;
  }

  // Schedule ALL effects at the top (after cheap hot filter) so DODO + token metadata
  // participate in Envio preload batching + memoization. PoolMeta write moved after guard.
  // See https://docs.envio.dev/docs/HyperIndex/event-handlers#preload-optimization
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

  context.PoolMeta.set({
    id: pool,
    address: pool,
    protocol: "DODO_V2",
    tokens: [base, quote],
    fee: 10,
    tickSpacing: undefined,
    createdBlock: blockNumber,
    createdTx: txHash,
    poolId: undefined,
  });

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
    if (INDEXER_HOT_BIAS && !involvesHotBase(event.params.baseToken, event.params.quoteToken)) {
      return;
    }
    context.chain.DodoPool.add(event.params.dvm);

    if (context.log) {
      context.log.info("Registered dynamic DODO pool (DVM)", { pool: event.params.dvm });
    }
  },
);

indexer.contractRegister(
  { contract: "DodoFactory", event: "DPPDeployed" },
  async ({ event, context }) => {
    if (INDEXER_HOT_BIAS && !involvesHotBase(event.params.baseToken, event.params.quoteToken)) {
      return;
    }
    context.chain.DodoPool.add(event.params.dpp);

    if (context.log) {
      context.log.info("Registered dynamic DODO pool (DPP)", { pool: event.params.dpp });
    }
  },
);

indexer.contractRegister(
  { contract: "DodoFactory", event: "DSPDeployed" },
  async ({ event, context }) => {
    if (INDEXER_HOT_BIAS && !involvesHotBase(event.params.baseToken, event.params.quoteToken)) {
      return;
    }
    context.chain.DodoPool.add(event.params.dsp);

    if (context.log) {
      context.log.info("Registered dynamic DODO pool (DSP)", { pool: event.params.dsp });
    }
  },
);

// DVM
indexer.onEvent(
  {
    contract: "DodoFactory",
    event: "DVMDeployed",
  },
  async ({ event, context }) => {
    await handleDodoPool(
      context,
      event.params.dvm,
      event.params.baseToken,
      event.params.quoteToken,
      Number(event.block.number),
      event.transaction.hash,
    );
    // Note: handleDodoPool already performs the isPreload early return after effects.
  },
);

// DPP
indexer.onEvent(
  {
    contract: "DodoFactory",
    event: "DPPDeployed",
  },
  async ({ event, context }) => {
    await handleDodoPool(
      context,
      event.params.dpp,
      event.params.baseToken,
      event.params.quoteToken,
      Number(event.block.number),
      event.transaction.hash,
    );
    // Note: handleDodoPool already performs the isPreload early return after effects.
  },
);

// DSP
indexer.onEvent(
  {
    contract: "DodoFactory",
    event: "DSPDeployed",
  },
  async ({ event, context }) => {
    await handleDodoPool(
      context,
      event.params.dsp,
      event.params.baseToken,
      event.params.quoteToken,
      Number(event.block.number),
      event.transaction.hash,
    );
    // Note: handleDodoPool already performs the isPreload early return after effects.
  },
);
