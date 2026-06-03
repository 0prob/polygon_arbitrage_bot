/**
 * Lightweight hot token / garbage lists for Envio indexer `where` filtering and handler guards.
 *
 * This is a deliberate small duplication of src/config/hot_tokens.ts from the root bot.
 *
 * Strategic Context (Long-Tail / Low-Competition Arb Strategy):
 * The bot's primary edge comes from obscure, long-tail, low-competition paths
 * (obscure V2 factories, DODO, Curve, Balancer weighted, complex multi-hop).
 * See src/orchestrator/pass_loop.ts "LONG-TAIL / LOW-COMPETITION ARBITRAGE STRATEGY".
 *
 * Therefore:
 * - Default behavior (INDEXER_HOT_BIAS=false) = broad discovery. This is the
 *   intended mode for the long-tail strategy.
 * - INDEXER_HOT_BIAS=true is a *conservative / lower long-tail exposure* mode.
 *   It biases the indexer toward pools involving major bases. Use when you
 *   want reduced noise, lower risk of garbage, or temporarily higher liquidity
 *   focus. It works *against* the primary long-tail thesis.
 *
 * The hot list is still very valuable for:
 *   - Strong defensive garbage filtering (always recommended)
 *   - JS-level guards
 *   - Future prioritization logic inside the bot (finder scoring, etc.)
 *
 * Keep the two files in sync manually when updating core tokens or known factories.
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
