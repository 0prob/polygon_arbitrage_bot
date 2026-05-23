import { indexer } from "envio";
import { fetchDodoMetadata } from "../effects/dodo_metadata";
import { fetchTokenMeta } from "../effects/token_metadata";

async function handleDodoDeployed({ event, context }: any) {
  const base = event.params.baseToken.toLowerCase();
  const quote = event.params.quoteToken.toLowerCase();
  const pool = (event.params.dvm || event.params.dpp || event.params.dsp).toLowerCase();

  context.PoolMeta.set({
    id: pool,
    address: pool,
    protocol: "dodo_v2",
    tokens: [base, quote],
    fee: 10,
    tickSpacing: undefined,
    createdBlock: Number(event.block.number),
    createdTx: event.transaction.hash,
    poolId: undefined,
  });

  if (!context.isPreload) {
    const meta = await context.effect(fetchDodoMetadata, { pool });
    context.DodoPoolState.set({
      id: pool,
      address: pool,
      lastUpdatedBlock: Number(event.block.number),
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
}

indexer.onEvent({ contract: "DodoFactory", event: "DVMDeployed" }, handleDodoDeployed);
indexer.onEvent({ contract: "DodoFactory", event: "DPPDeployed" }, handleDodoDeployed);
indexer.onEvent({ contract: "DodoFactory", event: "DSPDeployed" }, handleDodoDeployed);
