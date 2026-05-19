import path from "path";
import { createDatabase, type CompatDatabase } from "./connection.ts";

export type V4PoolStateRow = {
  id: string;
  address: string;
  lastUpdatedBlock: number;
  sqrtPriceX96: string;
  liquidity: string;
  tick: number;
  fee: string;
  tickSpacing: number;
  hooks: string;
};

export function getHiDbPath(dataDir: string): string {
  return path.join(dataDir, "../hyperindex/.hyperindex/db.sqlite");
}

export function readHyperIndexState(hiDb: CompatDatabase, address: string): Record<string, unknown> | null {
  const addr = address.toLowerCase();
  const v2 = hiDb.prepare("SELECT reserve0, reserve1 FROM v2_pool_state WHERE id = ?").get(addr) as
    { reserve0: string; reserve1: string } | undefined;
  if (v2) return { reserve0: BigInt(v2.reserve0), reserve1: BigInt(v2.reserve1) };

  const v3 = hiDb.prepare("SELECT sqrtPriceX96, liquidity, tick FROM v3_pool_state WHERE id = ?").get(addr) as
    { sqrtPriceX96: string; liquidity: string; tick: number } | undefined;
  if (v3) return { sqrtPriceX96: BigInt(v3.sqrtPriceX96), liquidity: BigInt(v3.liquidity), tick: v3.tick };

  const v4 = hiDb.prepare("SELECT sqrtPriceX96, liquidity, tick FROM v4_pool_state WHERE id = ?").get(addr) as
    { sqrtPriceX96: string; liquidity: string; tick: number } | undefined;
  if (v4) return { sqrtPriceX96: BigInt(v4.sqrtPriceX96), liquidity: BigInt(v4.liquidity), tick: v4.tick };

  const curve = hiDb.prepare("SELECT balances, A, fee FROM curve_pool_state WHERE id = ?").get(addr) as
    { balances: string; A: string; fee: string } | undefined;
  if (curve) {
    let balances: bigint[];
    try { balances = JSON.parse(curve.balances).map((b: string) => BigInt(b)); } catch { balances = []; }
    return { balances, A: BigInt(curve.A), fee: BigInt(curve.fee) };
  }

  return null;
}

export function readHyperIndexPools(dataDir: string): Array<{ address: string; protocol: string; tokens: string }> {
  try {
    const hiDbPath = getHiDbPath(dataDir);
    const hiDb = createDatabase(hiDbPath);
    const rows = hiDb.prepare("SELECT id, protocol, tokens FROM pool_meta").all() as Array<{
      id: string; protocol: string; tokens: string;
    }>;
    hiDb.close();
    return rows.map(r => ({ address: r.id, protocol: r.protocol, tokens: r.tokens }));
  } catch {
    return [];
  }
}

export function buildStateCacheFromHyperIndex(hiDbPath: string, addresses: string[]): Map<string, Record<string, unknown>> {
  const cache = new Map<string, Record<string, unknown>>();
  try {
    const hiDb = createDatabase(hiDbPath);
    for (const addr of addresses) {
      const state = readHyperIndexState(hiDb, addr);
      if (state) cache.set(addr.toLowerCase(), state);
    }
    hiDb.close();
  } catch {
    // HyperIndex DB not available yet
  }
  return cache;
}
