import { indexer } from "envio";

/**
 * Uniswap V2 Pool Sync — intentional no-op for live-debug discovery indexing.
 *
 * Hot pool state is fetched by the arb bot via RPC (fetchMissingPoolState).
 * Skipping per-Sync writes keeps DB Writes near zero during historical backfill.
 */
indexer.onEvent(
  {
    contract: "UniswapV2Pool",
    event: "Sync",
  },
  async () => {},
);
