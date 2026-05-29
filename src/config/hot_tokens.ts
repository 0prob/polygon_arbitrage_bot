import type { Address } from "../core/types/common.ts";

/**
 * Hot / high-value base tokens for Polygon arbitrage.
 *
 * Strategic Context:
 * The bot deliberately pursues a LONG-TAIL / LOW-COMPETITION strategy
 * (see src/orchestrator/pass_loop.ts and src/pipeline/finder.ts).
 * Its edge comes from obscure pools and complex paths, not head-to-head
 * competition on the hottest WMATIC-USDC / WETH-USDC pairs.
 *
 * These tokens are still critical as "anchors" for many long-tail cycles.
 *
 * Use cases for this list:
 * - Strong defensive garbage filtering in the indexer (recommended always)
 * - Optional "hot bias" mode in the Envio indexer (`INDEXER_HOT_BIAS=true`)
 *   → This biases discovery toward major bases. It is a *conservative mode*
 *     that reduces long-tail exposure. Default (false) = broad discovery.
 * - Prioritization / scoring inside the bot (finder, rates, risk).
 *
 * Source of truth alignment:
 * - Mirrors the "core" list in hyperindex/src/effects/token_registry.ts
 * - Kept in sync with src/config/addresses.ts
 */

export const HOT_BASE_TOKENS: readonly Address[] = [
  "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270", // WMATIC (native gas — highest priority)
  "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619", // WETH
  "0x2791bca1f2de4661ed88a30c99a7a9449aa84174", // USDC (PoS)
  "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", // USDC.e (native)
  "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", // USDT
  "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063", // DAI
  "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", // WBTC
] as const;

export const HOT_BASE_TOKENS_SET = new Set(HOT_BASE_TOKENS.map((a) => a.toLowerCase()));

/**
 * Known factory addresses that sometimes appear as "tokens" in broken PairCreated/PoolCreated events.
 * Used for defensive filtering (both in the root bot's garbage tracker and indexer where/JS guards).
 *
 * Keep this in sync with src/infra/hypersync/hyperindex_graphql.ts:KNOWN_FACTORIES.
 */
export const KNOWN_FACTORIES: readonly Address[] = [
  "0x5757371414417b8c6caad45baef941abc7d3ab32", // Quickswap V2
  "0xc35dadb65012ec5796536bd9864ed8773abc74c4", // Sushiswap V2
  "0x9e5a52f57b3038f1b8eee45f28b3c1967e22799c", // Uniswap V2
  "0x1f98431c8ad98523631ae4a59f267346ea31f984", // Uniswap V3
  "0x917933899c6a5f8e37f31e19f92cdbff7e8ff0e2", // Sushi V3
  "0x411b0facc3489691f28ad58c47006af5e3ab3a28", // Quickswap V3
] as const;

export const KNOWN_FACTORIES_SET = new Set(KNOWN_FACTORIES.map((a) => a.toLowerCase()));

/**
 * Zero address (common source of broken emissions).
 */
export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/**
 * Returns true if at least one of the two tokens is in the hot base set.
 * Useful for optional "hot bias" logic in discovery or where filters.
 */
export function involvesHotBase(token0: string, token1: string): boolean {
  const t0 = token0.toLowerCase();
  const t1 = token1.toLowerCase();
  return HOT_BASE_TOKENS_SET.has(t0) || HOT_BASE_TOKENS_SET.has(t1);
}

/**
 * Returns true if either token is a known factory or zero (strong signal of garbage PairCreated).
 */
export function isLikelyGarbagePair(token0: string, token1: string): boolean {
  const t0 = token0.toLowerCase();
  const t1 = token1.toLowerCase();
  return (
    t0 === ZERO_ADDRESS ||
    t1 === ZERO_ADDRESS ||
    KNOWN_FACTORIES_SET.has(t0) ||
    KNOWN_FACTORIES_SET.has(t1) ||
    t0 === t1
  );
}
