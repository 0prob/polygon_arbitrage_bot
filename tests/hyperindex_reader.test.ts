import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  buildStateCacheFromHyperIndex,
  resetHyperIndexReaderCache,
} from "../src/infra/db/hyperindex_reader.ts";

let testCounter = 0;
let baseDir: string;

function createHiDb(): string {
  const dir = join(baseDir, `test-${testCounter++}`);
  const hiDir = join(dir, "hyperindex");
  mkdirSync(hiDir, { recursive: true });
  return join(hiDir, "hyperindex.db");
}

function populateV2Pool(db: Database, rows: Array<{ id: string; lastUpdatedBlock: number; reserve0: string; reserve1: string }>) {
  db.exec("CREATE TABLE IF NOT EXISTS v2_pool_state (id TEXT PRIMARY KEY, lastUpdatedBlock INTEGER, reserve0 TEXT, reserve1 TEXT)");
  const stmt = db.prepare("INSERT OR REPLACE INTO v2_pool_state (id, lastUpdatedBlock, reserve0, reserve1) VALUES (?, ?, ?, ?)");
  for (const r of rows) stmt.run(r.id, r.lastUpdatedBlock, r.reserve0, r.reserve1);
}

function populateV3Pool(
  db: Database,
  rows: Array<{ id: string; lastUpdatedBlock: number; sqrtPriceX96: string; liquidity: string; tick: number }>,
) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS v3_pool_state (id TEXT PRIMARY KEY, lastUpdatedBlock INTEGER, sqrtPriceX96 TEXT, liquidity TEXT, tick INTEGER)",
  );
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO v3_pool_state (id, lastUpdatedBlock, sqrtPriceX96, liquidity, tick) VALUES (?, ?, ?, ?, ?)",
  );
  for (const r of rows) stmt.run(r.id, r.lastUpdatedBlock, r.sqrtPriceX96, r.liquidity, r.tick);
}

function populateCurvePool(
  db: Database,
  rows: Array<{ id: string; lastUpdatedBlock: number; balances: string; A: string; fee: string }>,
) {
  db.exec("CREATE TABLE IF NOT EXISTS curve_pool_state (id TEXT PRIMARY KEY, lastUpdatedBlock INTEGER, balances TEXT, A TEXT, fee TEXT)");
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO curve_pool_state (id, lastUpdatedBlock, balances, A, fee) VALUES (?, ?, ?, ?, ?)",
  );
  for (const r of rows) stmt.run(r.id, r.lastUpdatedBlock, r.balances, r.A, r.fee);
}

function populateBalancerPool(
  db: Database,
  rows: Array<{
    id: string;
    lastUpdatedBlock: number;
    poolId: string;
    balances: string;
    weights: string;
    amp: string | null;
    swapFee: string;
  }>,
) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS balancer_pool_state (id TEXT PRIMARY KEY, lastUpdatedBlock INTEGER, poolId TEXT, balances TEXT, weights TEXT, amp TEXT, swapFee TEXT)",
  );
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO balancer_pool_state (id, lastUpdatedBlock, poolId, balances, weights, amp, swapFee) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const r of rows) stmt.run(r.id, r.lastUpdatedBlock, r.poolId, r.balances, r.weights, r.amp, r.swapFee);
}

function populateCheckpoint(db: Database, blockNumber: number) {
  db.exec("CREATE TABLE IF NOT EXISTS checkpoint (block_number INTEGER)");
  db.prepare("INSERT OR REPLACE INTO checkpoint (rowid, block_number) VALUES (1, ?)").run(blockNumber);
}

beforeAll(() => {
  baseDir = mkdtempSync(join(tmpdir(), "hi-reader-test-"));
});

afterAll(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetHyperIndexReaderCache();
});

describe("buildStateCacheFromHyperIndex", () => {
  it("reads V2 pool state with correct BigInt values", () => {
    const dbPath = createHiDb();
    const db = new Database(dbPath, { create: true });
    populateCheckpoint(db, 100);
    populateV2Pool(db, [
      { id: "0xpool1", lastUpdatedBlock: 100, reserve0: "1000000", reserve1: "2000000" },
      { id: "0xpool2", lastUpdatedBlock: 95, reserve0: "3000000", reserve1: "4000000" },
    ]);
    db.close();

    const cache = buildStateCacheFromHyperIndex(dbPath, []);
    expect(cache.size).toBe(2);
    expect(cache.get("0xpool1")).toEqual({ reserve0: 1000000n, reserve1: 2000000n });
    expect(cache.get("0xpool2")).toEqual({ reserve0: 3000000n, reserve1: 4000000n });
  });

  it("reads V3 pool state with correct BigInt values", () => {
    const dbPath = createHiDb();
    const db = new Database(dbPath, { create: true });
    populateCheckpoint(db, 100);
    populateV3Pool(db, [
      { id: "0xv3pool1", lastUpdatedBlock: 100, sqrtPriceX96: "12345678901234567890", liquidity: "5000000", tick: 12345 },
    ]);
    db.close();

    const cache = buildStateCacheFromHyperIndex(dbPath, []);
    expect(cache.size).toBe(1);
    expect(cache.get("0xv3pool1")).toEqual({
      sqrtPriceX96: 12345678901234567890n,
      liquidity: 5000000n,
      tick: 12345,
    });
  });

  it("reads Curve pool state with JSON array balances", () => {
    const dbPath = createHiDb();
    const db = new Database(dbPath, { create: true });
    populateCheckpoint(db, 100);
    populateCurvePool(db, [
      {
        id: "0xcurve1",
        lastUpdatedBlock: 100,
        balances: JSON.stringify(["1000000", "2000000", "3000000"]),
        A: "100",
        fee: "3000000",
      },
    ]);
    db.close();

    const cache = buildStateCacheFromHyperIndex(dbPath, []);
    expect(cache.size).toBe(1);
    const state = cache.get("0xcurve1") as any;
    expect(state.A).toBe(100n);
    expect(state.fee).toBe(3000000n);
    expect(state.balances).toEqual([1000000n, 2000000n, 3000000n]);
  });

  it("reads Balancer pool state including swapFee", () => {
    const dbPath = createHiDb();
    const db = new Database(dbPath, { create: true });
    populateCheckpoint(db, 100);
    populateBalancerPool(db, [
      {
        id: "0xbal1",
        lastUpdatedBlock: 100,
        poolId: "0xpoolid",
        balances: JSON.stringify(["5000000", "6000000"]),
        weights: JSON.stringify(["500000000000000000", "500000000000000000"]),
        amp: null,
        swapFee: "10000000000000000",
      },
    ]);
    db.close();

    const cache = buildStateCacheFromHyperIndex(dbPath, []);
    expect(cache.size).toBe(1);
    const state = cache.get("0xbal1") as any;
    expect(state.swapFee).toBe(10000000000000000n);
    expect(state.balances).toEqual([5000000n, 6000000n]);
    expect(state.weights).toEqual([500000000000000000n, 500000000000000000n]);
  });

  it("handles missing DB path gracefully", () => {
    const cache = buildStateCacheFromHyperIndex("/nonexistent/db.db", []);
    expect(cache.size).toBe(0);
  });

  it("handles DB with no tables gracefully", () => {
    const dbPath = createHiDb();
    const db = new Database(dbPath, { create: true });
    db.close();

    const cache = buildStateCacheFromHyperIndex(dbPath, []);
    expect(cache.size).toBe(0);
  });

  it("incrementally fetches only new data after checkpoint advances", () => {
    const dbPath = createHiDb();
    const db = new Database(dbPath, { create: true });
    populateCheckpoint(db, 50);
    populateV2Pool(db, [{ id: "0xpool_old", lastUpdatedBlock: 50, reserve0: "100", reserve1: "200" }]);
    db.close();

    // First call: fetches all data at block 50
    const cache1 = buildStateCacheFromHyperIndex(dbPath, []);
    expect(cache1.size).toBe(1);

    // Add new data at block 100, advance checkpoint
    const db2 = new Database(dbPath);
    populateCheckpoint(db2, 100);
    populateV2Pool(db2, [
      { id: "0xpool_old", lastUpdatedBlock: 100, reserve0: "150", reserve1: "250" },
      { id: "0xpool_new", lastUpdatedBlock: 100, reserve0: "300", reserve1: "400" },
    ]);
    db2.close();

    // Second call: fetches only rows with lastUpdatedBlock > 50
    const cache2 = buildStateCacheFromHyperIndex(dbPath, []);
    expect(cache2.size).toBe(2);
    expect(cache2.get("0xpool_old")).toEqual({ reserve0: 150n, reserve1: 250n });
    expect(cache2.get("0xpool_new")).toEqual({ reserve0: 300n, reserve1: 400n });
  });

  it("returns cached state without re-querying when checkpoint has not advanced", () => {
    const dbPath = createHiDb();
    const db = new Database(dbPath, { create: true });
    populateCheckpoint(db, 100);
    populateV2Pool(db, [{ id: "0xpool1", lastUpdatedBlock: 100, reserve0: "100", reserve1: "200" }]);
    db.close();

    const cache1 = buildStateCacheFromHyperIndex(dbPath, []);
    expect(cache1.size).toBe(1);
    expect(cache1.get("0xpool1")).toEqual({ reserve0: 100n, reserve1: 200n });

    // Same checkpoint — should return cached data without re-querying
    const cache2 = buildStateCacheFromHyperIndex(dbPath, []);
    expect(cache2.size).toBe(1);
    expect(cache2.get("0xpool1")).toEqual({ reserve0: 100n, reserve1: 200n });
  });

  it("reads multiple pool types merged into the same cache", () => {
    const dbPath = createHiDb();
    const db = new Database(dbPath, { create: true });
    populateCheckpoint(db, 100);
    populateV2Pool(db, [{ id: "0xpool_v2", lastUpdatedBlock: 100, reserve0: "10", reserve1: "20" }]);
    populateV3Pool(db, [{ id: "0xpool_v3", lastUpdatedBlock: 100, sqrtPriceX96: "1000", liquidity: "2000", tick: 10 }]);
    populateCurvePool(db, [
      { id: "0xpool_curve", lastUpdatedBlock: 100, balances: JSON.stringify(["1", "2"]), A: "50", fee: "100" },
    ]);
    db.close();

    const cache = buildStateCacheFromHyperIndex(dbPath, []);
    expect(cache.size).toBe(3);
    expect(cache.get("0xpool_v2")).toHaveProperty("reserve0");
    expect(cache.get("0xpool_v3")).toHaveProperty("sqrtPriceX96");
    expect(cache.get("0xpool_curve")).toHaveProperty("A");
  });
});
