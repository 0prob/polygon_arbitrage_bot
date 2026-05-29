import { indexer } from "envio";

/**
 * Live debug indexer: per-event V2PoolState writes removed.
 *
 * Previously this handler wrote V2PoolState on every Sync (highest volume event on Polygon).
 * That drove DB Writes to ~60% of pipeline split time during live tail.
 *
 * For the arb bot's "live debug indexer" use case:
 * - Pool discovery happens via V2Factory.PairCreated (writes PoolMeta + TokenMeta only).
 * - Live state for simulation comes from the bot's RPC fetcher (fetchMissingPoolState).
 * - buildStateCacheFromGraphQL is best-effort bootstrap; missing state is tolerated.
 *
 * Result: DB writes are now minimal (creation-time metadata only). Loaders + handlers dominate.
 */
indexer.onEvent(
  { contract: "UniswapV2Pool", event: "Sync" },
  async () => {
    // No-op for live debug indexer.
    // No entity writes — eliminates the dominant source of DB write time in pipeline split.
  },
);
