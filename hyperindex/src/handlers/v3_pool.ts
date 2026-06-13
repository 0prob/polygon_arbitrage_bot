import { indexer } from "envio";

/**
 * Uniswap V3 Pool events — intentional no-ops for live-debug discovery indexing.
 *
 * Pool metadata comes from V3Factory.PoolCreated; hot state from the arb bot RPC fetcher.
 */
indexer.onEvent({ contract: "UniswapV3Pool", event: "Initialize" }, async () => {});

indexer.onEvent({ contract: "UniswapV3Pool", event: "Swap" }, async () => {});
