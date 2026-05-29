import { indexer } from "envio";

/**
 * Live debug indexer: per-event V3PoolState writes removed.
 *
 * Swap is the highest-frequency event for V3 pools. Initialize is rarer (pool creation).
 * Previous implementation cached fee/tickSpacing in memory solely to avoid DB reads
 * before every V3PoolState.set() — that pattern existed only because of the write load.
 *
 * For live debug:
 * - V3Factory.PoolCreated handles discovery (PoolMeta + TokenMeta).
 * - No per-Swap or per-Initialize state writes.
 * - Bot relies on RPC fetcher for live V3 state (sqrtPrice, liquidity, tick).
 *
 * This drops DB write time dramatically in pipeline split for live tail.
 */
indexer.onEvent(
  { contract: "UniswapV3Pool", event: "Initialize" },
  async () => {
    // No-op. Creation-time metadata already written by V3Factory.PoolCreated.
  },
);

indexer.onEvent(
  { contract: "UniswapV3Pool", event: "Swap" },
  async () => {
    // No-op for live debug indexer.
    // Eliminates the dominant DB write source for V3 (Swap events).
  },
);
