import { indexer } from "envio";

/**
 * Live debug indexer: per-event CurvePoolState writes removed.
 *
 * Curve pools emit TokenExchange/AddLiquidity/Remove* at moderate frequency.
 * Previous code maintained balances on every event via CurvePoolState.set + in-memory meta cache.
 *
 * For live debug use case the bot uses direct RPC fetches for Curve state.
 * CurveRegistry.PoolAdded (in curve_factory.ts) still writes initial CurvePoolState + PoolMeta
 * at pool creation time — that remains (rare, cheap).
 */
indexer.onEvent(
  { contract: "CurvePool", event: "TokenExchange" },
  async () => {
    // No-op. Live state via RPC fetcher; creation metadata via CurveRegistry.
  },
);

indexer.onEvent(
  { contract: "CurvePool", event: "AddLiquidity" },
  async () => {
    // No-op.
  },
);

indexer.onEvent(
  { contract: "CurvePool", event: "RemoveLiquidity" },
  async () => {
    // No-op.
  },
);

indexer.onEvent(
  { contract: "CurvePool", event: "RemoveLiquidityOne" },
  async () => {
    // No-op.
  },
);
