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

  // V2
  const v2 = hiDb.prepare("SELECT reserve0, reserve1 FROM v2_pool_state WHERE id = ?").get(addr) as
    { reserve0: string; reserve1: string } | undefined;
  if (v2) return { reserve0: BigInt(v2.reserve0), reserve1: BigInt(v2.reserve1) };

  // V3
  const v3 = hiDb.prepare("SELECT sqrtPriceX96, liquidity, tick FROM v3_pool_state WHERE id = ?").get(addr) as
    { sqrtPriceX96: string; liquidity: string; tick: number } | undefined;
  if (v3) return { sqrtPriceX96: BigInt(v3.sqrtPriceX96), liquidity: BigInt(v3.liquidity), tick: v3.tick };

  // V4
  const v4 = hiDb.prepare("SELECT sqrtPriceX96, liquidity, tick, fee, tickSpacing, hooks FROM v4_pool_state WHERE id = ?").get(addr) as
    { sqrtPriceX96: string; liquidity: string; tick: number; fee: string; tickSpacing: number; hooks: string } | undefined;
  if (v4) return {
    sqrtPriceX96: BigInt(v4.sqrtPriceX96),
    liquidity: BigInt(v4.liquidity),
    tick: v4.tick,
    fee: BigInt(v4.fee),
    tickSpacing: v4.tickSpacing,
    hooks: v4.hooks
  };

  // Curve
  const curve = hiDb.prepare("SELECT balances, A, fee FROM curve_pool_state WHERE id = ?").get(addr) as
    { balances: string; A: string; fee: string } | undefined;
  if (curve) {
    let balances: bigint[];
    try { balances = JSON.parse(curve.balances).map((b: string) => BigInt(b)); } catch { balances = []; }
    return { balances, A: BigInt(curve.A), fee: BigInt(curve.fee) };
  }

  // Balancer
  const balancer = hiDb.prepare("SELECT poolId, balances, weights, amp, swapFee FROM balancer_pool_state WHERE id = ?").get(addr) as
    { poolId: string; balances: string; weights: string; amp: string; swapFee: string } | undefined;
  if (balancer) {
    let balances: bigint[];
    let weights: bigint[];
    try { balances = JSON.parse(balancer.balances).map((b: string) => BigInt(b)); } catch { balances = []; }
    try { weights = JSON.parse(balancer.weights).map((w: string) => BigInt(w)); } catch { weights = []; }
    return {
      poolId: balancer.poolId,
      balances,
      weights,
      amp: balancer.amp ? BigInt(balancer.amp) : undefined,
      swapFee: BigInt(balancer.swapFee)
    };
  }

  // Dodo
  const dodo = hiDb.prepare("SELECT baseReserve, quoteReserve, targetBase, targetQuote, rStatus, k, fee FROM dodo_pool_state WHERE id = ?").get(addr) as
    { baseReserve: string; quoteReserve: string; targetBase: string; targetQuote: string; rStatus: number; k: string; fee: string } | undefined;
  if (dodo) return {
    baseReserve: BigInt(dodo.baseReserve),
    quoteReserve: BigInt(dodo.quoteReserve),
    targetBase: BigInt(dodo.targetBase),
    targetQuote: BigInt(dodo.targetQuote),
    rStatus: dodo.rStatus,
    k: BigInt(dodo.k),
    fee: BigInt(dodo.fee)
  };

  // Woofi
  const woofi = hiDb.prepare("SELECT price, coefficient, spread, fee FROM woofi_pool_state WHERE id = ?").get(addr) as
    { price: string; coefficient: string; spread: string; fee: string } | undefined;
  if (woofi) return {
    price: BigInt(woofi.price),
    coefficient: BigInt(woofi.coefficient),
    spread: BigInt(woofi.spread),
    fee: BigInt(woofi.fee)
  };

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
