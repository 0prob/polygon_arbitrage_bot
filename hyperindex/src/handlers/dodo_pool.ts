import { indexer } from "envio";

/**
 * DODO pool Sync — intentional no-op for live-debug discovery indexing.
 *
 * Initial pool metadata comes from dodo_factory handlers; hot state from arb bot RPC.
 */
indexer.onEvent({ contract: "DodoPool", event: "Sync" }, async () => {});
