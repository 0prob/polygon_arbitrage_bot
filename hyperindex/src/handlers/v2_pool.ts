import { indexer } from "envio";

/**
 * Live debug / discovery-only indexer profile (Envio v3 recommended pattern).
 *
 * High-volume events (Sync, Swap, etc.) are intentionally no-op at the handler level.
 * This keeps DB writes near zero during live tail (see pipeline split metrics).
 *
 * Discovery of new pools still flows through the factory events (PairCreated / PoolCreated)
 * which write only PoolMeta + TokenMeta.
 *
 * The arbitrage bot relies on:
 *   - Its own RPC fetcher (`fetchMissingPoolState`) for hot state
 *   - Periodic pool discovery from Hasura
 *
 * References:
 *   - https://docs.envio.dev/docs/HyperIndex/preload-optimization
 *   - https://docs.envio.dev/docs/HyperIndex/event-handlers#performance-considerations
 */
indexer.onEvent(
  {
    contract: "UniswapV2Pool",
    event: "Sync",
    // No `where` needed here — contractRegister from the factory already limits
    // this wildcard to only addresses we actually care about.
  },
  async () => {
    // Deliberate no-op. This is the key optimization for the bot's live-debug use case.
  },
);
