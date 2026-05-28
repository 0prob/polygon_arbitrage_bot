import { indexer } from "envio";

const dodoMetaCache = new Map<string, {
  targetBase: bigint;
  targetQuote: bigint;
  rStatus: number;
  k: bigint;
  fee: bigint;
  i: bigint;
  lpFeeRate: bigint;
  mtFeeRate: bigint;
}>();

indexer.onEvent(
  { contract: "DodoPool", event: "Sync" },
  async ({ event, context }) => {
    const addr = event.srcAddress.toLowerCase();

    const cached = dodoMetaCache.get(addr);
    if (cached) {
      context.DodoPoolState.set({
        id: addr,
        address: addr,
        lastUpdatedBlock: Number(event.block.number),
        baseReserve: event.params.reserve0,
        quoteReserve: event.params.reserve1,
        ...cached,
      });
      return;
    }

    const existing = await context.DodoPoolState.get(addr);
    if (!existing) return;

    const meta = {
      targetBase: existing.targetBase,
      targetQuote: existing.targetQuote,
      rStatus: existing.rStatus,
      k: existing.k,
      fee: existing.fee,
      i: existing.i,
      lpFeeRate: existing.lpFeeRate,
      mtFeeRate: existing.mtFeeRate,
    };
    dodoMetaCache.set(addr, meta);

    context.DodoPoolState.set({
      id: addr,
      address: addr,
      lastUpdatedBlock: Number(event.block.number),
      baseReserve: event.params.reserve0,
      quoteReserve: event.params.reserve1,
      ...meta,
    });
  },
);
