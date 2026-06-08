/**
 * Lightweight hot token / garbage lists for Envio indexer `where` filtering and handler guards.
 *
 * Strategic Context (Long-Tail / Low-Competition Arb Strategy on Low Infra):
 * The bot's primary edge comes from obscure, long-tail, low-competition paths
 * (obscure V2 factories, DODO, Curve, Balancer weighted, complex multi-hop).
 * See src/orchestrator/pass_loop.ts "LONG-TAIL / LOW-COMPETITION ARBITRAGE STRATEGY".
 *
 * Low-infra adaptation: unlikely to win saturated hot pairs (needs speed/advantage).
 * Expand this HOT_BASE list (and sync MAJOR_TOKENS + rate seeds in bot) to
 * give rate propagation more bridges. This reduces persistent high noRate for
 * long-tail cycles that now have a path to MATIC price via expanded bases.
 * For low infra: strongly prefer INDEXER_HOT_BIAS=true + this expanded list.
 * This limits total pools (less state/RPC pressure on 250 RPS etc) while the
 * broader bases still surface many "alt + base" long-tail opportunities that
 * the math + obscurity scoring can exploit. Broad mode on low infra often starves
 * rates (high noRate).
 *
 * Therefore:
 * - Default behavior (INDEXER_HOT_BIAS=false) = broad discovery. This is the
 *   intended mode for the long-tail strategy.
 * - INDEXER_HOT_BIAS=true is a *conservative / lower long-tail exposure* mode.
 *   It biases the indexer toward pools involving major bases. Use when you
 *   want reduced noise, lower risk of garbage, or temporarily higher liquidity
 *   focus on low infra (pairs well with expanded list here).
 *
 * The hot list is still very valuable for:
 *   - Strong defensive garbage filtering (always recommended)
 *   - JS-level guards
 *   - Future prioritization logic inside the bot (finder scoring, etc.)
 *
 * Keep this file and the MAJOR_TOKENS + seed lists in pass_loop.ts / rates.ts in sync
 * manually when updating.
 */

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const HOT_BASE_TOKENS = [
  "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270", // WMATIC
  "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619", // WETH
  "0x2791bca1f2de4661ed88a30c99a7a9449aa84174", // USDC (PoS)
  "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", // USDC.e
  "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", // USDT
  "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063", // DAI
  "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", // WBTC
  // Expanded for better rate coverage / lower noRate on low-infra runs.
  // More bases = more connecting pools for propagation to long-tail tokens,
  // while still filtering garbage. Aligns with broad discovery for long-tail strategy
  // (primary edge on low infra where hot-pair competition is not viable).
  "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", // LINK
  "0xd6df932a45c0f255f85145f286ea0b292b21c90b", // AAVE
  "0x172370d5cd63279efa6d502dab29171933a610af", // CRV
  "0x9a71012b13ca4d3d0cdcbc8942ec6c4e9e0e6c8c", // BAL
  "0xb33eaad8d922b1083446dc23f610c2567fb5180f", // UNI
  "0x385eeac5cb85a38a9a07a70c73e0a3271cfb54a7", // GHST
  "0xb5c064f955d8e7f38fe0460c556a72987494ee17", // QUICK
  "0xdf7836e3278cdcaf450c33a9254848982424b6e5", // TEL
  "0xbbba073c31bf03b8acf7c28ef0738decf41bb5df", // SAND
  "0x5fe2b58c013d7601147dcdd68c143a77499f5531", // GRT
];

export const HOT_BASE_SET = new Set(HOT_BASE_TOKENS.map((a) => a.toLowerCase()));

export const KNOWN_FACTORIES = [
  "0x5757371414417b8c6caad45baef941abc7d3ab32", // Quickswap V2
  "0xc35dadb65012ec5796536bd9864ed8773abc74c4", // Sushiswap V2
  "0x9e5a52f57b3038f1b8eee45f28b3c1967e22799c", // Uniswap V2
  "0x1f98431c8ad98523631ae4a59f267346ea31f984", // Uniswap V3
  "0x917933899c6a5f8e37f31e19f92cdbff7e8ff0e2", // Sushi V3
  "0x411b0facc3489691f28ad58c47006af5e3ab3a28", // Quickswap V3
];

export const KNOWN_FACTORIES_SET = new Set(KNOWN_FACTORIES.map((a) => a.toLowerCase()));

export function isLikelyGarbagePair(token0: string, token1: string): boolean {
  const t0 = token0.toLowerCase();
  const t1 = token1.toLowerCase();
  return t0 === ZERO_ADDRESS || t1 === ZERO_ADDRESS || KNOWN_FACTORIES_SET.has(t0) || KNOWN_FACTORIES_SET.has(t1) || t0 === t1;
}

/**
 * For optional "hot bias" mode in where filters or discovery.
 */
export function involvesHotBase(token0: string, token1: string): boolean {
  const t0 = token0.toLowerCase();
  const t1 = token1.toLowerCase();
  return HOT_BASE_SET.has(t0) || HOT_BASE_SET.has(t1);
}

/**
 * Returns a `where` filter object suitable for Envio `onEvent` / `contractRegister`
 * on factory creation events.
 *
 * When `hotBias` is true → applies positive filter requiring at least one
 * token from HOT_BASE_TOKENS. This is the "conservative / hot focus" mode.
 *
 * LONG-TAIL STRATEGY ALIGNMENT:
 * The bot's primary edge is in obscure, low-competition paths.
 * Enabling hot-bias here intentionally reduces long-tail discovery.
 * Default (false) = broad discovery (aligned with the strategy in pass_loop.ts).
 *
 * `paramNames` controls the event parameter names to filter on.
 */
export function createHotBiasWhere(hotBias: boolean, paramNames: [string, string] = ["token0", "token1"]) {
  if (!hotBias) {
    return undefined;
  }

  const [p0, p1] = paramNames;

  return {
    params: [{ [p0]: HOT_BASE_TOKENS }, { [p1]: HOT_BASE_TOKENS }],
  };
}

/** Convenience: read the bias flag from environment (recommended way for hyperindex). */
export const INDEXER_HOT_BIAS =
  process.env.ENVIO_INDEXER_HOT_BIAS === "true" ||
  process.env.ENVIO_INDEXER_HOT_BIAS === "1" ||
  process.env.INDEXER_HOT_BIAS === "true" ||
  process.env.INDEXER_HOT_BIAS === "1";
