import { indexer } from "envio";
import { fetchTokenMeta } from "../effects/token_metadata";
import { logEffectTime } from "../utils/instrumentation";
import { getMetadataConcurrency, runWithConcurrency } from "../utils/pacing";

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
  | "WOOFI"
  | "UNKNOWN_V2"
  | "UNKNOWN_V3";

indexer.onEvent(
  {
    contract: "WooPPV2",
    event: "WooSwap",
  },
  async ({ event, context }) => {
    const poolAddr = event.srcAddress;
    const t0 = event.params.fromToken;
    const t1 = event.params.toToken;
    const blockNumber = Number(event.block.number);

    // Retrieve metadata for this pool to check if it's already registered
    const meta = await context.PoolMeta.get(poolAddr);

    if (!meta) {
      // Concurrently fetch token metadata
      const tEff0 = Date.now();
      const concurrency = getMetadataConcurrency();
      const [t0meta, t1meta] = await runWithConcurrency([t0, t1], concurrency, (addr) => context.effect(fetchTokenMeta, { address: addr }));
      logEffectTime("fetchTokenMeta:woofi", Date.now() - tEff0, blockNumber);

      if (context.isPreload) {
        return;
      }

      // Register WOOFi pool in PoolMeta
      context.PoolMeta.set({
        id: poolAddr,
        address: poolAddr,
        protocol: "WOOFI" as Protocol,
        tokens: [t0, t1],
        fee: Number(event.params.swapFee), // WOOFi swap fee (often dynamically set but recorded here)
        tickSpacing: undefined,
        createdBlock: blockNumber,
        createdTx: event.transaction.hash,
        poolId: undefined,
      });

      context.TokenMeta.set({ id: t0, address: t0, decimals: t0meta.decimals });
      context.TokenMeta.set({ id: t1, address: t1, decimals: t1meta.decimals });
    }
  },
);
