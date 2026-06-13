import { indexer } from "envio";
import { fetchTokenMeta } from "../effects/token_metadata";
import { logEffectTime } from "../utils/instrumentation";
import { setTokenMetasIfMissing } from "../utils/entity_writes";
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

const ZERO = "0x0000000000000000000000000000000000000000";
/** Typical WOOFi pool fee in 1e5 units (25 = 0.025%). swapFee event param is wei paid, not the rate. */
const DEFAULT_WOOFI_FEE = 25;

function mergeTokens(existing: string[] | undefined, ...add: string[]): string[] {
  const out = [...(existing ?? [])];
  for (const raw of add) {
    const t = raw.toLowerCase();
    if (t === ZERO || out.includes(t)) continue;
    out.push(t);
  }
  return out;
}

/**
 * WooSwap — lazy pool discovery on first sight of a token pair only.
 *
 * WOOFi has no factory event; the first swap per new token is the discovery path.
 * Repeat swaps with no new tokens are a no-op (no effects, no DB writes).
 */
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

    const meta = await context.PoolMeta.get(poolAddr);
    const mergedTokens = mergeTokens(meta?.tokens, t0, t1);
    if (mergedTokens.length < 2) return;

    const newTokens = mergedTokens.filter((t) => !(meta?.tokens ?? []).includes(t));
    if (newTokens.length === 0) return;

    const tEff0 = Date.now();
    const concurrency = getMetadataConcurrency();
    const tokenMetas = await runWithConcurrency(newTokens, concurrency, (addr) =>
      context.effect(fetchTokenMeta, { address: addr }),
    );
    logEffectTime("fetchTokenMeta:woofi", Date.now() - tEff0, blockNumber);

    if (context.isPreload) {
      return;
    }

    context.PoolMeta.set({
      id: poolAddr,
      address: poolAddr,
      protocol: "WOOFI" as Protocol,
      tokens: mergedTokens,
      fee: meta?.fee && meta.fee > 0 ? meta.fee : DEFAULT_WOOFI_FEE,
      tickSpacing: undefined,
      createdBlock: meta?.createdBlock ?? blockNumber,
      createdTx: meta?.createdTx ?? event.transaction.hash,
      poolId: undefined,
    });

    await setTokenMetasIfMissing(
      context,
      newTokens,
      tokenMetas.map((m) => m.decimals),
    );
  },
);
