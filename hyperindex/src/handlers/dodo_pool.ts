import { indexer } from "envio";

/**
 * Live debug indexer: per-Sync DodoPoolState writes removed.
 *
 * Initial DodoPoolState is written once at deploy time in dodo_factory.ts (handleDodoPool).
 * Repeated Sync updates were causing unnecessary DB writes for live tail.
 */
indexer.onEvent({ contract: "DodoPool", event: "Sync" }, async () => {
  // No-op. Creation-time state from factory; live updates via bot RPC fetcher.
});
