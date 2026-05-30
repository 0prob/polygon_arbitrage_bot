/**
 * HyperIndex Pipeline Instrumentation
 *
 * Purpose: Make "Pipeline split" (Loaders / Handlers / DB Writes) observable and debuggable.
 *
 * Envio semantics (from envio dev / metrics TUI):
 *   - Loaders  = wall time spent inside context.effect(...) calls (the effect fn body)
 *   - Handlers = wall time spent in onEvent/contractRegister bodies *excluding* effects
 *   - DB Writes = time in entity persistence (.set / .delete)
 *
 * Why this indexer shows ~99% Loaders / 0% Handlers / 0% DB:
 *   - Pool event handlers (Sync/Swap/...) are deliberate no-ops: async () => {}
 *   - Factory handlers spend almost all time in context.effect(fetchTokenMeta / fetch*Metadata)
 *   - After effects: only a few .set() calls + early return on context.isPreload
 *   - .set() calls are skipped entirely during preload phase (per Envio best practice)
 *
 * This is *by design* for the "live debug discovery feed" use case:
 *   - The arb bot uses its own RPC fetcher for hot state (fetchMissingPoolState)
 *   - HyperIndex only provides: (a) new pool discovery, (b) best-effort bootstrap cache
 *   - Zero per-event state writes on high-volume events → DB Writes near zero
 *
 * To observe real numbers:
 *   1. cd hyperindex && bun run dev   (or root `bun run dev`)
 *   2. Watch envio stdout / TUI for pipeline split percentages
 *   3. Or grep logs for "PIPELINE_SPLIT" if you add a periodic emitter
 *
 * Common causes of pathological "Loaders: 99%":
 *   - Broken/slow RPC endpoints in rpc_client.ts (was the #1 cause — truncated Alchemy key)
 *   - Token missing from STATIC_TOKEN_DECIMALS → every PairCreated does 1-2 RPC roundtrips
 *   - Effect cache: false or cold start (first historical backfill pass)
 *   - Rate limit throttling inside effects (429s, quota errors → retries + backoff)
 *
 * Fix levers (in priority order):
 *   1. POLYGON_RPC_URLS with fast archival provider(s) in .env (top priority)
 *   2. Keep scripts/generate-polygon-tokens.ts output complete (run `bun run gentok`)
 *   3. Effect cache: true (already set on all effects)
 *   4. Parallel Promise.all for independent effects (already done in handlers)
 *   5. Raise full_batch_size only if you have RPC headroom
 */

export interface TimingSample {
  name: string;
  durationMs: number;
  blockNumber?: number;
}

/**
 * Wrap an async operation and log its duration.
 * Use this inside handlers around context.effect calls for fine-grained visibility.
 *
 * Example:
 *   const t0 = Date.now();
 *   const meta = await context.effect(fetchTokenMeta, ...);
 *   logEffectTime("fetchTokenMeta", Date.now() - t0, Number(event.block.number));
 */
export function logEffectTime(name: string, durationMs: number, blockNumber?: number): void {
  // Only log slow effects (>50ms) to avoid noise in normal operation.
  // Fast cached hits are <1ms and are the common case after warmup.
  if (durationMs > 50) {
    console.log(
      JSON.stringify({
        level: 30,
        time: Date.now(),
        msg: "SLOW_EFFECT",
        effect: name,
        durationMs: Math.round(durationMs),
        block: blockNumber,
      })
    );
  }
}

/**
 * Simple synchronous timing for pure handler work (post-effect).
 * Call at the start and end of the non-effect portion of a handler.
 */
export function timeHandlerBody<T>(name: string, fn: () => T): T {
  const t0 = Date.now();
  const result = fn();
  const dt = Date.now() - t0;
  if (dt > 5) {
    console.log(
      JSON.stringify({
        level: 30,
        time: Date.now(),
        msg: "HANDLER_BODY",
        handler: name,
        durationMs: dt,
      })
    );
  }
  return result;
}
