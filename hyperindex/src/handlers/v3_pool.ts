import { indexer } from "envio";

/**
 * Live debug / discovery-only profile for V3 (see v2_pool.ts for full rationale).
 *
 * We keep the wildcard registration so that contractRegister from V3Factory works,
 * but we emit zero entity writes on the hot path (Swap is extremely high volume on Polygon).
 */
indexer.onEvent({ contract: "UniswapV3Pool", event: "Initialize" }, async () => {
  // Creation metadata already handled in V3Factory.PoolCreated
});

indexer.onEvent({ contract: "UniswapV3Pool", event: "Swap" }, async () => {
  // No-op — state comes from bot's RPC fetcher instead.
});
