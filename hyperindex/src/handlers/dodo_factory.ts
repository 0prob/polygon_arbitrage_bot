import { indexer, Effect } from "envio";
import { fetchDodoMetadata } from "../effects/dodo_metadata";
import { fetchTokenMeta } from "../effects/token_metadata";
import { involvesHotBase, INDEXER_HOT_BIAS } from "../utils/hot_tokens";
import { logEffectTime } from "../utils/instrumentation";
import { getMetadataConcurrency, runWithConcurrency } from "../utils/pacing";

interface DodoHandlerContext {
  effect: <I, O>(effect: Effect<I, O>, input: I extends undefined ? undefined : I) => Promise<O>;
  isPreload: boolean;
  PoolMeta: { set: (entity: unknown) => void };
  DodoPoolState: { set: (entity: unknown) => void };
  TokenMeta: { set: (entity: unknown) => void };
}

async function handleDodoPool(
  context: DodoHandlerContext,
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
  //
  // Use bounded concurrency (via runWithConcurrency) when HYPERSYNC_RPM_TARGET is low to avoid request spikes.
  // We start the DODO meta effect + the (possibly limited) token effects concurrently.
  const tEffDodo = Date.now();
  const concurrency = getMetadataConcurrency();
  const dodoP = context.effect(fetchDodoMetadata, { pool, blockNumber: BigInt(blockNumber) });
  const tokensP = runWithConcurrency([base, quote], concurrency, (addr) => context.effect(fetchTokenMeta, { address: addr }));
  const [meta, tokenMetas] = await Promise.all([dodoP, tokensP]);
  const [baseMeta, quoteMeta] = tokenMetas as Array<{ decimals: number }>;
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

const DODO_POOL_EVENTS = [
  { event: "DVMDeployed" as const, poolField: "dvm" as const, label: "DVM" },
  { event: "DPPDeployed" as const, poolField: "dpp" as const, label: "DPP" },
  { event: "DSPDeployed" as const, poolField: "dsp" as const, label: "DSP" },
];

function registerDodoEvent(cfg: (typeof DODO_POOL_EVENTS)[number]): void {
  indexer.contractRegister({ contract: "DodoFactory", event: cfg.event }, async ({ event: ev, context }: any) => {
    // eslint-disable-line @typescript-eslint/no-explicit-any
    if (INDEXER_HOT_BIAS && !involvesHotBase(ev.params.baseToken, ev.params.quoteToken)) {
      return;
    }
    context.chain.DodoPool.add(ev.params[cfg.poolField]);
    if (context.log) {
      context.log.info(`Registered dynamic DODO pool (${cfg.label})`, { pool: ev.params[cfg.poolField] });
    }
  });

  indexer.onEvent({ contract: "DodoFactory", event: cfg.event }, async ({ event: ev, context }: any) => {
    // eslint-disable-line @typescript-eslint/no-explicit-any
    await handleDodoPool(
      context,
      ev.params[cfg.poolField],
      ev.params.baseToken,
      ev.params.quoteToken,
      Number(ev.block.number),
      ev.transaction.hash,
    );
  });
}

for (const cfg of DODO_POOL_EVENTS) {
  registerDodoEvent(cfg);
}
