import { indexer } from "envio";
import { fetchDodoMetadata } from "../effects/dodo_metadata";
import { fetchTokenMeta } from "../effects/token_metadata";

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

  const meta = await context.effect(fetchDodoMetadata, { pool });
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
  });

  const [baseMeta, quoteMeta] = await Promise.all([
    context.effect(fetchTokenMeta, { address: base }),
    context.effect(fetchTokenMeta, { address: quote }),
  ]);
  context.TokenMeta.set({ id: base, address: base, decimals: baseMeta.decimals });
  context.TokenMeta.set({ id: quote, address: quote, decimals: quoteMeta.decimals });
}

indexer.onEvent(
  { contract: "DodoFactory", event: "DVMDeployed" },
  async ({ event, context }) => {
    await handleDodoPool(
      context,
      event.params.dvm.toLowerCase(),
      event.params.baseToken.toLowerCase(),
      event.params.quoteToken.toLowerCase(),
      Number(event.block.number),
      event.transaction.hash,
    );
  },
);

indexer.onEvent(
  { contract: "DodoFactory", event: "DPPDeployed" },
  async ({ event, context }) => {
    await handleDodoPool(
      context,
      event.params.dpp.toLowerCase(),
      event.params.baseToken.toLowerCase(),
      event.params.quoteToken.toLowerCase(),
      Number(event.block.number),
      event.transaction.hash,
    );
  },
);

indexer.onEvent(
  { contract: "DodoFactory", event: "DSPDeployed" },
  async ({ event, context }) => {
    await handleDodoPool(
      context,
      event.params.dsp.toLowerCase(),
      event.params.baseToken.toLowerCase(),
      event.params.quoteToken.toLowerCase(),
      Number(event.block.number),
      event.transaction.hash,
    );
  },
);
