/**
 * HyperIndex handler architecture (Envio side).
 *
 * External I/O: createEffect + context.effect() only (see src/effects/).
 * Parallel RPC inside effects: Promise.all where inputs are independent.
 * Handler parallelism: runWithConcurrency / Promise.all on context.effect calls.
 *
 * Writable entities (discovery metadata only):
 *   PoolMeta, TokenMeta, IndexerProgress, BalancerPoolIdToAddress
 *
 * Do NOT write *PoolState entities — the arb bot owns hot state via RPC multicall.
 * High-volume pool events (Sync/Swap/...) must remain intentional no-ops.
 */

export const INDEXER_WRITABLE_ENTITIES = [
  "PoolMeta",
  "TokenMeta",
  "IndexerProgress",
  "BalancerPoolIdToAddress",
] as const;

export const INDEXER_FORBIDDEN_STATE_WRITES = [
  "V2PoolState",
  "V3PoolState",
  "V4PoolState",
  "CurvePoolState",
  "BalancerPoolState",
  "DodoPoolState",
] as const;
