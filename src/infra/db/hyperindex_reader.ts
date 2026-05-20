import path from "path";
import { createDatabase, type CompatDatabase } from "./connection.ts";

export function getHiDbPath(dataDir: string): string {
  return path.join(dataDir, "../hyperindex/hyperindex.db");
}

// Internal cache to avoid redundant work in the same process
let _hiDb: CompatDatabase | null = null;
let _cachedState: Map<string, Record<string, unknown>> = new Map();
let _lastFetchedBlock: number = -1;

export function readHyperIndexPools(dataDir: string): Array<{ address: string; protocol: string; tokens: string; created_block: number; created_tx: string }> {
  try {
    const hiDbPath = getHiDbPath(dataDir);
    if (!_hiDb) _hiDb = createDatabase(hiDbPath);
    const hiDb = _hiDb;
    // Only fetch pools that we don't already know?
    // Usually pool metadata is small enough to fetch once at boot.
    const rows = hiDb.prepare("SELECT id, protocol, tokens, created_block, created_tx FROM pool_meta").all() as Array<{
      id: string; protocol: string; tokens: string; created_block: number; created_tx: string;
    }>;
    return rows.map(r => ({
      address: r.id,
      protocol: r.protocol,
      tokens: r.tokens,
      created_block: r.created_block,
      created_tx: r.created_tx
    }));
  } catch {
    return [];
  }
}

/**
 * Optimally builds or updates the state cache by only fetching rows that have changed
 * since the last call.
 */
export function buildStateCacheFromHyperIndex(hiDbPath: string, _addresses: string[]): Map<string, Record<string, unknown>> {
  try {
    if (!_hiDb) _hiDb = createDatabase(hiDbPath);
    const hiDb = _hiDb;

    // Optimization: query for the current "head" block of the indexer
    // We assume the checkpoint table exists
    const checkpointRow = hiDb.prepare("SELECT block_number FROM checkpoint ORDER BY block_number DESC LIMIT 1").get() as { block_number: number } | undefined;
    const currentHead = checkpointRow ? checkpointRow.block_number : 999999999;

    if (currentHead <= _lastFetchedBlock && _cachedState.size > 0) {
      return _cachedState;
    }
    const fetchSince = _lastFetchedBlock;

    // Helper to merge rows into cache
    const merge = (rows: any[], mapper: (r: any) => Record<string, unknown>) => {
      for (const r of rows) {
        _cachedState.set(r.id.toLowerCase(), mapper(r));
      }
    };

    // V2
    merge(
      hiDb.prepare("SELECT id, reserve0, reserve1 FROM v2_pool_state WHERE lastUpdatedBlock > ?").all(fetchSince),
      r => ({ reserve0: BigInt(r.reserve0), reserve1: BigInt(r.reserve1) })
    );

    // V3
    merge(
      hiDb.prepare("SELECT id, sqrtPriceX96, liquidity, tick FROM v3_pool_state WHERE lastUpdatedBlock > ?").all(fetchSince),
      r => ({ sqrtPriceX96: BigInt(r.sqrtPriceX96), liquidity: BigInt(r.liquidity), tick: r.tick })
    );

    // V4
    merge(
      hiDb.prepare("SELECT id, sqrtPriceX96, liquidity, tick, fee, tickSpacing, hooks FROM v4_pool_state WHERE lastUpdatedBlock > ?").all(fetchSince),
      r => ({
        sqrtPriceX96: BigInt(r.sqrtPriceX96),
        liquidity: BigInt(r.liquidity),
        tick: r.tick,
        fee: BigInt(r.fee),
        tickSpacing: r.tickSpacing,
        hooks: r.hooks
      })
    );

    // Curve
    merge(
      hiDb.prepare("SELECT id, balances, A, fee FROM curve_pool_state WHERE lastUpdatedBlock > ?").all(fetchSince),
      r => {
        let balances: bigint[];
        try { balances = JSON.parse(r.balances).map((b: string) => BigInt(b)); } catch { balances = []; }
        return { balances, A: BigInt(r.A), fee: BigInt(r.fee) };
      }
    );

    // Balancer
    merge(
      hiDb.prepare("SELECT id, poolId, balances, weights, amp, swapFee FROM balancer_pool_state WHERE lastUpdatedBlock > ?").all(fetchSince),
      r => {
        let balances: bigint[];
        let weights: bigint[];
        try { balances = JSON.parse(r.balances).map((b: string) => BigInt(b)); } catch { balances = []; }
        try { weights = JSON.parse(r.weights).map((w: string) => BigInt(w)); } catch { weights = []; }
        return {
          poolId: r.poolId,
          balances,
          weights,
          amp: r.amp ? BigInt(r.amp) : undefined,
          swapFee: BigInt(r.swapFee)
        };
      }
    );

    _lastFetchedBlock = currentHead;
  } catch (err) {
    // If table doesn't exist yet, we just return the existing cache (or empty)
  }
  return _cachedState;
}

export function readHyperIndexState(hiDb: CompatDatabase, address: string): Record<string, unknown> | null {
  // Direct lookup fallback if cache miss or specific forced refresh
  const addr = address.toLowerCase();
  const cached = _cachedState.get(addr);
  if (cached) return cached;

  // Fallback to individual queries (same as before but using the open hiDb)
  const v2 = hiDb.prepare("SELECT reserve0, reserve1 FROM v2_pool_state WHERE id = ?").get(addr) as any;
  if (v2) return { reserve0: BigInt(v2.reserve0), reserve1: BigInt(v2.reserve1) };

  const v3 = hiDb.prepare("SELECT sqrtPriceX96, liquidity, tick FROM v3_pool_state WHERE id = ?").get(addr) as any;
  if (v3) return { sqrtPriceX96: BigInt(v3.sqrtPriceX96), liquidity: BigInt(v3.liquidity), tick: v3.tick };

  return null;
}
