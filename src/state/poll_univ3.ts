/**
 * src/state/poll_univ3.ts — Continuous V3 tick + liquidity state poller
 *
 * Fetches slot0, liquidity, tick bitmap, and initialized tick data for all
 * active V3 pools (Uniswap V3, QuickSwap V3, SushiSwap V3, KyberSwap Elastic)
 * and writes
 * normalized state into a shared in-memory cache.
 *
 * Usage:
 *   import { PollUniv3 } from "./poll_univ3.js";
 *   const poller = new PollUniv3(registry, stateCache, { concurrency: 2 });
 *   await poller.poll();
 *   poller.start(20_000);
 *   poller.stop();
 */

import { fetchMultipleV3States, type V3PoolMeta } from "./uniswap_v3.ts";
import { normalizeV3State } from "./normalizer.ts";
import {
  TimedPoller,
  type ProtocolPoolRecord,
  type RouteState,
  type RouteStateCache,
  type StatePollerOptions,
  type TokenDecimalsRegistry,
} from "./poller_base.ts";
import { mergeStateIntoCache } from "./cache_utils.ts";
import { V3_POLL_MAX_POOLS } from "../config/index.ts";
import { parsePoolMetadata, parsePoolTokens } from "./pool_record.ts";
import { metadataWithRegistryTokenDecimals } from "./pool_metadata.ts";
import { normalizeProtocolKey, V3_PROTOCOLS } from "../protocols/classification.ts";

type V3PollerOptions = StatePollerOptions & {
  maxPools?: number;
};

function metadataFee(value: unknown): V3PoolMeta["swapFeeBps"] {
  if (value == null) return null;
  if (typeof value === "number" || typeof value === "string" || typeof value === "bigint") return value;
  return null;
}

function isAlgebraPool(pool: ProtocolPoolRecord) {
  const metadata = parsePoolMetadata(pool?.metadata);
  const protocol = normalizeProtocolKey(pool?.protocol);
  return (
    protocol === "QUICKSWAP_V3" || protocol === "KYBERSWAP_ELASTIC" || metadata?.isAlgebra === true || metadata?.isKyberElastic === true
  );
}

// ─── Poller class ─────────────────────────────────────────────

export class PollUniv3 extends TimedPoller {
  private _registry: TokenDecimalsRegistry;
  private _cache: RouteStateCache;
  private _concurrency: number;
  private _maxPools: number;

  constructor(registry: TokenDecimalsRegistry, stateCache: RouteStateCache, options: V3PollerOptions = {}) {
    super(options);
    this._registry = registry;
    this._cache = stateCache;
    this._concurrency = options.concurrency ?? 2;
    this._maxPools = options.maxPools ?? V3_POLL_MAX_POOLS;
  }

  // ─── Single poll pass ───────────────────────────────────────

  /**
   * Fetch V3 pool state for all active V3 pools and update the cache.
   *
   * @returns {Promise<{ updated: number, failed: number, durationMs: number }>}
   */
  async poll() {
    const t0 = Date.now();

    const pools = this._registry
      .getActivePoolsMeta()
      .filter((p) => V3_PROTOCOLS().has(normalizeProtocolKey(p.protocol)))
      .slice(0, this._maxPools);

    if (pools.length === 0) {
      return { updated: 0, failed: 0, durationMs: Date.now() - t0 };
    }

    const addresses = pools.map((p) => p.pool_address);

    // Build per-pool metadata so Algebra-family pools (QuickSwap V3, KyberSwap
    // Elastic) use globalState() instead of slot0(), while standard Uniswap V3
    // forks use slot0().
    const poolMeta = new Map<string, V3PoolMeta>();
    for (const pool of pools) {
      if (isAlgebraPool(pool)) {
        const protocol = normalizeProtocolKey(pool.protocol);
        const metadata = parsePoolMetadata(pool.metadata);
        poolMeta.set(pool.pool_address.toLowerCase(), {
          isAlgebra: true,
          isKyberElastic: protocol === "KYBERSWAP_ELASTIC" || metadata.isKyberElastic === true,
          swapFeeBps: metadataFee(metadata.swapFeeBps),
          swapFeeUnits: metadataFee(metadata.swapFeeUnits),
        });
      }
    }

    // Batch-fetch V3 state (expensive — full tick bitmap + tick data)
    const statesMap = await fetchMultipleV3States(addresses, this._concurrency, poolMeta);

    let updated = 0;
    let failed = 0;

    for (const pool of pools) {
      const addr = pool.pool_address.toLowerCase();
      const rawState = statesMap.get(addr);

      if (!rawState) {
        failed++;
        continue;
      }

      const tokens = parsePoolTokens(pool.tokens);
      const metadata = metadataWithRegistryTokenDecimals(this._registry, pool, tokens);
      const normalized = normalizeV3State(addr, normalizeProtocolKey(pool.protocol), tokens, rawState, metadata) as RouteState;

      mergeStateIntoCache(this._cache, addr, normalized);
      updated++;

      if (this._verbose) {
        console.log(`[poll_univ3] ${addr} tick=${rawState.tick} liq=${rawState.liquidity}`);
      }
    }

    return this._completePass("poll_univ3", t0, updated, failed);
  }

  // ─── Continuous polling ──────────────────────────────────────

  /**
   * Start continuous polling.
   *
   * Note: V3 state fetches are slow (many RPC sub-calls per pool).
   * Recommended interval is 20–60 seconds.
   *
   * @param {number} intervalMs  Milliseconds between polls
   */
  start(intervalMs = 30_000) {
    this._startLoop("poll_univ3", intervalMs, () => this.poll());
  }
}
