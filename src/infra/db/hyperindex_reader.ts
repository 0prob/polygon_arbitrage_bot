import fs from "fs";
import path from "path";
import { createDatabase, type CompatDatabase } from "./connection.ts";

export function getHiDbPath(dataDir: string): string {
  return path.join(dataDir, "../hyperindex/hyperindex.db");
}

const MAX_CACHED_STATE_ENTRIES = 10_000;

// Internal cache to avoid redundant work in the same process
let _hiDb: CompatDatabase | null = null;
const _cachedState: Map<string, Record<string, unknown>> = new Map();
let _lastFetchedBlock: number = -1;
const _cacheAccessOrder: string[] = [];

function tableExists(hiDb: CompatDatabase, tableName: string): boolean {
  try {
    const row = hiDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
    return !!row;
  } catch {
    return false;
  }
}

export function readHyperIndexPools(dataDir: string): Array<{ address: string; protocol: string; tokens: string; created_block: number; created_tx: string }> {
  try {
    const hiDbPath = getHiDbPath(dataDir);
    if (!fs.existsSync(hiDbPath)) return [];
    if (!_hiDb) _hiDb = createDatabase(hiDbPath);
    const hiDb = _hiDb;

    if (!tableExists(hiDb, "pool_meta")) return [];

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
    if (!fs.existsSync(hiDbPath)) return _cachedState;
    if (!_hiDb) _hiDb = createDatabase(hiDbPath);
    const hiDb = _hiDb;

    // Optimization: query for the current "head" block of the indexer
    // We assume the checkpoint table exists
    let currentHead = 999999999;
    if (tableExists(hiDb, "checkpoint")) {
      const checkpointRow = hiDb.prepare("SELECT block_number FROM checkpoint ORDER BY block_number DESC LIMIT 1").get() as { block_number: number } | undefined;
      if (checkpointRow) currentHead = checkpointRow.block_number;
    }

    if (currentHead <= _lastFetchedBlock && _cachedState.size > 0) {
      return _cachedState;
    }
    const fetchSince = _lastFetchedBlock;

    // Helper to merge rows into cache with FIFO eviction at MAX_CACHED_STATE_ENTRIES
    const merge = (rows: any[], mapper: (r: any) => Record<string, unknown>) => {
      for (const r of rows) {
        const addr = r.id.toLowerCase();
        const newData = mapper(r);
        const existing = _cachedState.get(addr);
        if (existing) {
          Object.assign(existing, newData);
        } else {
          if (_cachedState.size >= MAX_CACHED_STATE_ENTRIES) {
            const oldest = _cacheAccessOrder.shift()!;
            _cachedState.delete(oldest);
          }
          _cachedState.set(addr, newData);
          _cacheAccessOrder.push(addr);
        }
      }
    };

    // V2
    if (tableExists(hiDb, "v2_pool_state")) {
      merge(
        hiDb.prepare("SELECT id, reserve0, reserve1 FROM v2_pool_state WHERE lastUpdatedBlock > ?").all(fetchSince),
        r => ({ reserve0: BigInt(r.reserve0), reserve1: BigInt(r.reserve1) })
      );
    }

    // V3
    if (tableExists(hiDb, "v3_pool_state")) {
      merge(
        hiDb.prepare("SELECT id, sqrtPriceX96, liquidity, tick FROM v3_pool_state WHERE lastUpdatedBlock > ?").all(fetchSince),
        r => ({ sqrtPriceX96: BigInt(r.sqrtPriceX96), liquidity: BigInt(r.liquidity), tick: r.tick })
      );
    }

    // V4
    if (tableExists(hiDb, "v4_pool_state")) {
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
    }

    // Curve
    if (tableExists(hiDb, "curve_pool_state")) {
      merge(
        hiDb.prepare("SELECT id, balances, A, fee FROM curve_pool_state WHERE lastUpdatedBlock > ?").all(fetchSince),
        r => {
          let balances: bigint[];
          try { balances = JSON.parse(r.balances).map((b: string) => BigInt(b)); } catch { balances = []; }
          return { balances, A: BigInt(r.A), fee: BigInt(r.fee) };
        }
      );
    }

    // Balancer
    if (tableExists(hiDb, "balancer_pool_state")) {
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
    }

    _lastFetchedBlock = currentHead;
  } catch {
    // If table doesn't exist yet, we just return the existing cache (or empty)
  }
  return _cachedState;
}

export function readHyperIndexState(hiDb: CompatDatabase, address: string): Record<string, unknown> | null {
  const addr = address.toLowerCase();
  const cached = _cachedState.get(addr);
  if (cached) {
    // Update access order when entry is touched
    const idx = _cacheAccessOrder.indexOf(addr);
    if (idx > -1) {
      _cacheAccessOrder.splice(idx, 1);
      _cacheAccessOrder.push(addr);
    }
    return cached;
  }

  // Fallback to individual queries (same as before but using the open hiDb)
  if (tableExists(hiDb, "v2_pool_state")) {
    const v2 = hiDb.prepare("SELECT reserve0, reserve1 FROM v2_pool_state WHERE id = ?").get(addr) as any;
    if (v2) return { reserve0: BigInt(v2.reserve0), reserve1: BigInt(v2.reserve1) };
  }

  if (tableExists(hiDb, "v3_pool_state")) {
    const v3 = hiDb.prepare("SELECT sqrtPriceX96, liquidity, tick FROM v3_pool_state WHERE id = ?").get(addr) as any;
    if (v3) return { sqrtPriceX96: BigInt(v3.sqrtPriceX96), liquidity: BigInt(v3.liquidity), tick: v3.tick };
  }

  return null;
}
