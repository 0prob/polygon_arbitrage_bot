/**
 * Data-plane contract between HyperIndex (Envio) and the arb bot.
 *
 * HyperIndex                          Bot
 * ─────────                           ───
 * PoolMeta discovery          →       InMemoryPoolGraph (meta index)
 * TokenMeta decimals          →       StateRefreshService.TokenMetas
 * IndexerProgress             →       HasuraProgressSubscriber
 * Effect API (RPC metadata)   ✓       fetchMissingPoolState (RPC multicall)
 * *PoolState entities         ✗       RouteStateCache (never read from Hasura)
 */

/** Hasura entities the bot may query. Hot reserves/slot0 are never among these. */
export const BOT_INDEXER_ENTITIES = ["PoolMeta", "TokenMeta", "IndexerProgress"] as const;

/** Legacy indexer entities kept in schema for backwards compat — bot must not read them. */
export const INDEXER_HOT_STATE_ENTITIES = [
  "V2PoolState",
  "V3PoolState",
  "V4PoolState",
  "CurvePoolState",
  "BalancerPoolState",
  "DodoPoolState",
] as const;

export type BotIndexerEntity = (typeof BOT_INDEXER_ENTITIES)[number];

export function assertBotIndexerTable(table: string): void {
  if (!(BOT_INDEXER_ENTITIES as readonly string[]).includes(table)) {
    throw new Error(
      `Architecture violation: bot must not query "${table}" from HyperIndex/Hasura. ` +
        `Hot pool state is owned by RPC (fetchMissingPoolState → RouteStateCache). ` +
        `Allowed indexer tables: ${BOT_INDEXER_ENTITIES.join(", ")}.`,
    );
  }
}
