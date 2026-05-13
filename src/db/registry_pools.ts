/**
 * src/db/registry_pools.js — Pool persistence/query helpers for RegistryService
 */

import fs from "fs";
import {
  lowerCaseAddressList,
  mapPoolMetaRow,
  mapPoolRow,
  mapStalePoolRow,
  parseJson,
  stringifyWithBigInt,
} from "./registry_codec.ts";
import { normalizeEvmAddress, parsePoolMetadataValue, parsePoolTokensValue } from "../utils/pool_record.ts";
import { isBalancerProtocol, isV3Protocol, normalizeProtocolKey } from "../protocols/classification.ts";
import { toBigIntOrNull } from "../utils/bigint.ts";
import { isPolygonSystemContract, isRecord } from "../utils/identity.ts";
import type { CompatDatabase } from "./sqlite.ts";

const POOL_STATUSES = new Set(["active", "disabled", "removed"]);

type SqlValue = null | number | bigint | string | NodeJS.ArrayBufferView;
type RegistryDatabase = Pick<CompatDatabase, "prepare" | "transaction">;
type StatementFactory = (key: string, sql: string) => ReturnType<CompatDatabase["statement"]>;
type InvalidatePoolMetaCache = () => void;
type PoolStatus = "active" | "disabled" | "removed";

type PoolRecordInput = Record<string, unknown>;

type PersistedPoolRecord = {
  pool_address: string;
  protocol: string;
  tokens: unknown;
  metadata?: unknown;
  status?: string;
  state?: { data?: Record<string, unknown> } | null;
  [key: string]: unknown;
};

type NormalizedPoolUpsertRecord = PoolRecordInput & {
  pool_address: string;
  protocol: string;
  block: number | null;
  tokens: string[];
  tx: string;
  metadata: Record<string, unknown>;
  status: PoolStatus;
  removed_block: number | null;
};

type NormalizedStateUpdate = {
  pool_address: string;
  block: number;
  data: unknown;
};

type PoolRemovalRecord = {
  address?: unknown;
  pool_address?: unknown;
  removed_block?: unknown;
  removedBlock?: unknown;
  block?: unknown;
};

type CountRow = { count?: unknown };
type AddressRow = { address?: unknown };
type ProtocolCountRow = { protocol?: unknown; count?: unknown };

type LiquidityState = {
  reserve0?: unknown;
  reserve1?: unknown;
  liquidity?: unknown;
};

type LiquidityEventRecorder = (
  poolAddress: string,
  blockNumber: number,
  eventType: string,
  oldValue: unknown,
  newValue: unknown,
) => unknown;



function normalizeRequiredAddress(value: unknown, label: string) {
  const normalizedAddress = normalizeEvmAddress(value);
  if (!normalizedAddress) {
    throw new Error(
      `RegistryService: valid ${label} is required`
    );
  }
  return normalizedAddress;
}

function assertPoolAddress(metadata: PoolRecordInput) {
  const addr = normalizeRequiredAddress(metadata.pool_address, `pool_address for protocol ${metadata.protocol}`);
  if (isPolygonSystemContract(addr)) {
    throw new Error(`RegistryService: Polygon system contract address cannot be used as pool: ${addr}`);
  }
}

function normalizePoolStatus(value: unknown): PoolStatus {
  const trimmed = value == null ? "" : String(value).trim();
  const status = (trimmed || "active").toLowerCase();
  if (!POOL_STATUSES.has(status)) {
    throw new Error(`RegistryService: invalid pool status: ${value}`);
  }
  return status as PoolStatus;
}

function normalizePoolBlock(value: unknown, label: string, fallback: number | null = null) {
  if (value == null || value === "") return fallback;
  const block = Number(value);
  if (!Number.isSafeInteger(block) || block < 0) {
    throw new Error(`RegistryService: invalid ${label}: ${value}`);
  }
  return block;
}

function normalizePoolUpsertRecord(pool: unknown): NormalizedPoolUpsertRecord {
  if (!isRecord(pool)) {
    throw new Error("RegistryService: pool metadata must be an object");
  }
  assertPoolAddress(pool);
  const removedBlock = pool.removed_block ?? pool.removedBlock ?? null;
  const protocol = normalizeProtocolKey(pool.protocol);
  if (!protocol) {
    throw new Error(`RegistryService: protocol is required for pool ${pool.pool_address}`);
  }
  const status = normalizePoolStatus(pool.status);
  const normalizedRemovedBlock = normalizePoolBlock(removedBlock, "removed_block", null);
  return {
    ...pool,
    pool_address: normalizeRequiredAddress(pool.pool_address, `pool_address for protocol ${protocol}`),
    protocol,
    block: normalizePoolBlock(pool.block ?? pool.created_block ?? pool.createdBlock, "created block", 0),
    tokens: lowerCaseAddressList(
      Array.isArray(pool.tokens) ? pool.tokens : parsePoolTokensValue(pool.tokens),
    ),
    tx: pool.tx != null ? String(pool.tx) : "",
    metadata: parsePoolMetadataValue(pool.metadata),
    status,
    removed_block: status === "removed" ? normalizedRemovedBlock : null,
  };
}

function normalizePoolUpsertBatch(poolList: unknown[]) {
  const latestByAddress = new Map<string, NormalizedPoolUpsertRecord>();
  let skipped = 0;
  let loggedErrors = 0;
  const MAX_LOG = 5;
  for (const pool of poolList) {
    try {
      const normalized = normalizePoolUpsertRecord(pool);
      latestByAddress.set(normalized.pool_address, normalized);
    } catch (err) {
      skipped++;
      if (loggedErrors < MAX_LOG) {
        console.warn(`  [registry] Skipping invalid pool: ${err instanceof Error ? err.message : String(err)}`);
        loggedErrors++;
      }
    }
  }
  if (skipped > MAX_LOG) {
    console.warn(`  [registry] ... and ${skipped - MAX_LOG} more invalid pool(s) skipped`);
  }
  return { records: [...latestByAddress.values()], skipped };
}

function normalizeStateUpdateRecord(state: unknown): NormalizedStateUpdate {
  if (!isRecord(state) || !state.pool_address) {
    throw new Error("RegistryService: pool_address is required for state update");
  }

  const block = Number(state.block ?? 0);
  if (!Number.isSafeInteger(block) || block < 0) {
    throw new Error(`RegistryService: invalid state block for ${state.pool_address}: ${state.block}`);
  }

  return {
    pool_address: normalizeRequiredAddress(state.pool_address, "pool_address for state update"),
    block,
    data: state.data,
  };
}

function normalizeStateUpdateBatch(stateList: unknown[]) {
  const latestByAddress = new Map<string, NormalizedStateUpdate>();
  let skipped = 0;
  let loggedErrors = 0;
  const MAX_LOG = 5;
  for (const state of stateList) {
    try {
      const normalized = normalizeStateUpdateRecord(state);
      const prior = latestByAddress.get(normalized.pool_address);
      if (!prior || normalized.block >= prior.block) {
        latestByAddress.set(normalized.pool_address, normalized);
      }
    } catch (err) {
      skipped++;
      if (loggedErrors < MAX_LOG) {
        console.warn(`  [registry] Skipping invalid state update: ${err instanceof Error ? err.message : String(err)}`);
        loggedErrors++;
      }
    }
  }
  if (skipped > MAX_LOG) {
    console.warn(`  [registry] ... and ${skipped - MAX_LOG} more invalid state update(s) skipped`);
  }
  return { records: [...latestByAddress.values()], skipped };
}

export function upsertPool(
  stmt: StatementFactory,
  invalidatePoolMetaCache: InvalidatePoolMetaCache,
  metadata: unknown,
) {
  const normalized = normalizePoolUpsertRecord(metadata);

  const upsertPoolStmt = stmt("upsertPool", `
    INSERT INTO pools (address, protocol, tokens, created_block, created_tx, metadata, status, removed_block)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET
      protocol = excluded.protocol,
      tokens   = excluded.tokens,
      created_block = excluded.created_block,
      created_tx    = excluded.created_tx,
      metadata = excluded.metadata,
      status   = excluded.status,
      removed_block = excluded.removed_block
  `);

  const result = upsertPoolStmt.run(
    normalized.pool_address,
    normalized.protocol,
    stringifyWithBigInt(normalized.tokens),
    normalized.block ?? 0,
    normalized.tx,
    stringifyWithBigInt(normalized.metadata),
    normalized.status,
    normalized.removed_block,
  );
  invalidatePoolMetaCache();
  return result;
}

export function removePool(
  stmt: StatementFactory,
  invalidatePoolMetaCache: InvalidatePoolMetaCache,
  address: unknown,
) {
  const normalizedAddress = normalizeRequiredAddress(address, "pool address");
  const result = stmt(
    "removePool",
    `UPDATE pools SET status = 'removed' WHERE address = ?`
  ).run(normalizedAddress);
  invalidatePoolMetaCache();
  return result;
}

export function batchRemovePools(
  stmt: StatementFactory,
  invalidatePoolMetaCache: InvalidatePoolMetaCache,
  db: RegistryDatabase,
  removals: unknown,
) {
  if (!Array.isArray(removals) || removals.length === 0) return 0;

  const removePoolStmt = stmt(
    "batchRemovePools",
    `UPDATE pools
     SET status = 'removed',
         removed_block = CASE
           WHEN removed_block IS NULL THEN ?
           ELSE removed_block
         END
     WHERE address = ?`
  );

  const removalByAddress = new Map<string, number | null>();
  for (const removal of removals as Array<string | PoolRemovalRecord>) {
    const addressValue =
      typeof removal === "string"
        ? removal
        : removal?.address ?? removal?.pool_address ?? null;
    const normalizedAddress = normalizeEvmAddress(addressValue);
    if (!normalizedAddress) continue;
    const removalBlockRaw =
      typeof removal === "string"
        ? null
        : removal?.removed_block ?? removal?.removedBlock ?? removal?.block ?? null;
    const removalBlock =
      removalBlockRaw == null || removalBlockRaw === ""
        ? null
        : Number(removalBlockRaw);
    const finiteRemovalBlock = Number.isFinite(removalBlock) ? removalBlock : null;
    const prior = removalByAddress.get(normalizedAddress);
    if (prior == null) {
      removalByAddress.set(normalizedAddress, finiteRemovalBlock);
      continue;
    }
    if (finiteRemovalBlock != null && (prior == null || finiteRemovalBlock < prior)) {
      removalByAddress.set(normalizedAddress, finiteRemovalBlock);
    }
  }

  if (removalByAddress.size === 0) return 0;

  const transaction = db.transaction((entries: unknown) => {
    let removed = 0;
    const removalEntries = Array.isArray(entries) ? entries as Array<[string, number | null]> : [];
    for (const [address, removedBlock] of removalEntries) {
      const result = removePoolStmt.run(removedBlock, address);
      removed += Number(result?.changes ?? 0);
    }
    return removed;
  });

  const removed = Number(transaction([...removalByAddress.entries()]));
  if (removed > 0) invalidatePoolMetaCache();
  return removed;
}

export function updatePoolState(stmt: StatementFactory, state: unknown) {
  const normalized = normalizeStateUpdateRecord(state);

  return stmt("updatePoolState", `
    INSERT INTO pool_state (address, last_updated_block, state_data)
    VALUES (?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET
      last_updated_block = excluded.last_updated_block,
      state_data         = excluded.state_data
    WHERE excluded.last_updated_block >= pool_state.last_updated_block
  `).run(
    normalized.pool_address,
    normalized.block,
    stringifyWithBigInt(normalized.data)
  );
}

export function getPools(db: RegistryDatabase, opts: Record<string, unknown> = {}) {
  let sql = `
    SELECT p.*, s.last_updated_block, s.state_data
    FROM pools p
    LEFT JOIN pool_state s ON p.address = s.address
  `;
  const conditions: string[] = [];
  const params: SqlValue[] = [];

  if (opts.protocol) {
    conditions.push("p.protocol = ?");
    params.push(normalizeProtocolKey(opts.protocol));
  }
  if (opts.status) {
    conditions.push("p.status = ?");
    params.push(String(opts.status));
  }
  if (conditions.length > 0) {
    sql += " WHERE " + conditions.join(" AND ");
  }

  sql += " ORDER BY p.address";

  const maxResults = opts.maxResults as number | undefined;
  if (typeof maxResults === "number" && maxResults > 0) {
    sql += " LIMIT ?";
    params.push(maxResults);
  }

  return db.prepare(sql).all(...params).map((row) => mapPoolRow(row));
}

export function loadPoolMetaCache(stmt: StatementFactory, status: string | null = null) {
  const cacheKey = status ? `getPoolMetaByStatus:${status}` : "getAllPoolMeta";
  const statusSql = status ? " WHERE status = ?" : "";
  const rows = stmt(
    cacheKey,
    `SELECT address, protocol, tokens, created_block, created_tx, metadata, status, removed_block
     FROM pools${statusSql}`
  ).all(...(status ? [status] : []));
  const pools = rows.map((row) => mapPoolMetaRow(row));

  if (status) {
    return pools;
  }

  return new Map(pools.map((pool) => [pool.pool_address, pool]));
}

export function getPool(stmt: StatementFactory, address: unknown) {
  const normalizedAddress = normalizeEvmAddress(address);
  if (!normalizedAddress) return null;

  const row = stmt(
    "getPool",
    `SELECT p.*, s.last_updated_block, s.state_data
     FROM pools p
     LEFT JOIN pool_state s ON p.address = s.address
     WHERE p.address = ?`
  ).get(normalizedAddress);
  return row ? mapPoolRow(row) : null;
}

export function getPoolCount(stmt: StatementFactory) {
  const row = stmt("getPoolCount", `SELECT COUNT(*) as count FROM pools`).get() as CountRow | undefined;
  return Number(row?.count ?? 0);
}

export function getActivePoolCount(stmt: StatementFactory) {
  const row = stmt(
    "getActivePoolCount",
    `SELECT COUNT(*) as count FROM pools WHERE status = 'active'`
  ).get() as CountRow | undefined;
  return Number(row?.count ?? 0);
}

export function getPoolCountForProtocol(stmt: StatementFactory, protocol: string, status: string | null = null) {
  const protocolKey = normalizeProtocolKey(protocol);
  const cacheKey = status
    ? `getPoolCountForProtocol:${protocolKey}:${status}`
    : `getPoolCountForProtocol:${protocolKey}:all`;
  const sql = status
    ? `SELECT COUNT(*) as count FROM pools WHERE protocol = ? AND status = ?`
    : `SELECT COUNT(*) as count FROM pools WHERE protocol = ?`;
  const row = stmt(cacheKey, sql).get(...(status ? [protocolKey, status] : [protocolKey])) as CountRow | undefined;
  return Number(row?.count ?? 0);
}

export function getPoolAddressesForProtocol(stmt: StatementFactory, protocol: string, status: string | null = null) {
  const protocolKey = normalizeProtocolKey(protocol);
  const cacheKey = status
    ? `getPoolAddressesForProtocol:${protocolKey}:${status}`
    : `getPoolAddressesForProtocol:${protocolKey}:all`;
  const sql = status
    ? `SELECT address FROM pools WHERE protocol = ? AND status = ?`
    : `SELECT address FROM pools WHERE protocol = ?`;
  return stmt(cacheKey, sql)
    .all(...(status ? [protocolKey, status] : [protocolKey]))
    .map((row) => normalizeEvmAddress((row as AddressRow).address))
    .filter((address): address is string => address != null);
}

export function batchUpsertPools(
  db: RegistryDatabase,
  stmt: StatementFactory,
  invalidatePoolMetaCache: InvalidatePoolMetaCache,
  poolList: unknown,
) {
  if (!Array.isArray(poolList) || poolList.length === 0) return { upserted: 0, skipped: 0 };
  const { records: normalizedPools, skipped } = normalizePoolUpsertBatch(poolList);
  if (normalizedPools.length === 0) return { upserted: 0, skipped };

  const upsertPoolStmt = stmt("upsertPool", `
    INSERT INTO pools (address, protocol, tokens, created_block, created_tx, metadata, status, removed_block)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET
      protocol = excluded.protocol,
      tokens   = excluded.tokens,
      created_block = excluded.created_block,
      created_tx    = excluded.created_tx,
      metadata = excluded.metadata,
      status   = excluded.status,
      removed_block = excluded.removed_block
  `);

  const upsertPools = db.transaction((pools: unknown) => {
    let changes = 0;
    const normalizedList = Array.isArray(pools) ? pools as NormalizedPoolUpsertRecord[] : [];
    for (const pool of normalizedList) {
      const result = upsertPoolStmt.run(
        pool.pool_address,
        pool.protocol,
        stringifyWithBigInt(pool.tokens || []),
        pool.block ?? 0,
        pool.tx,
        stringifyWithBigInt(pool.metadata),
        pool.status,
        pool.removed_block,
      );
      changes += Number(result?.changes ?? 0);
    }
    return changes;
  });
  const upserted = Number(upsertPools(normalizedPools));

  invalidatePoolMetaCache();
  return { upserted, skipped };
}

export function batchUpdateStates(db: RegistryDatabase, stmt: StatementFactory, stateList: unknown) {
  if (!Array.isArray(stateList) || stateList.length === 0) return { updated: 0, skipped: 0 };
  const { records: normalizedStates, skipped } = normalizeStateUpdateBatch(stateList);
  if (normalizedStates.length === 0) return { updated: 0, skipped };

  const updatePoolStateStmt = stmt("updatePoolState", `
    INSERT INTO pool_state (address, last_updated_block, state_data)
    VALUES (?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET
      last_updated_block = excluded.last_updated_block,
      state_data         = excluded.state_data
    WHERE excluded.last_updated_block >= pool_state.last_updated_block
  `);

  const updateStates = db.transaction((states: unknown) => {
    let changes = 0;
    const normalizedList = Array.isArray(states) ? states as NormalizedStateUpdate[] : [];
    for (const state of normalizedList) {
      const result = updatePoolStateStmt.run(
        state.pool_address,
        state.block,
        stringifyWithBigInt(state.data),
      );
      changes += Number(result?.changes ?? 0);
    }
    return changes;
  });
  const updated = Number(updateStates(normalizedStates));
  return { updated, skipped };
}

export function getPoolsWithState(db: RegistryDatabase, opts: Record<string, unknown> = {}) {
  let sql = `
    SELECT p.*, s.last_updated_block, s.state_data
    FROM pools p
    INNER JOIN pool_state s ON p.address = s.address
    WHERE p.status = 'active'
  `;
  const params: SqlValue[] = [];

  if (opts.protocol) {
    sql += " AND p.protocol = ?";
    params.push(normalizeProtocolKey(opts.protocol));
  }

  return db.prepare(sql).all(...params).map((row) => mapPoolRow(row));
}

export function getActivePoolsByProtocol(db: RegistryDatabase, protocol: unknown) {
  return getPools(db, { status: "active", protocol });
}

export function getHubAdjacentPools(db: RegistryDatabase, hubTokens: Iterable<unknown>) {
  const hubs = new Set(
    [...hubTokens]
      .map((token) => normalizeEvmAddress(token))
      .filter((token): token is string => token != null),
  );
  if (hubs.size === 0) return [];
  return getPools(db, { status: "active" }).filter((pool) => {
    const tokens = parsePoolTokensValue(pool.tokens);
    return tokens.some((token) => hubs.has(token.toLowerCase()));
  });
}

export function getRecentlyChangedPools(db: RegistryDatabase, sinceBlock: unknown) {
  const threshold = normalizePoolBlock(sinceBlock, "recently changed since block", 0) ?? 0;
  const sql = `
    SELECT DISTINCT p.*, s.last_updated_block, s.state_data
    FROM pools p
    INNER JOIN liquidity_events l ON l.address = p.address
    LEFT JOIN pool_state s ON p.address = s.address
    WHERE p.status = 'active'
      AND l.block_number >= ?
  `;
  return db.prepare(sql).all(threshold).map((row) => mapPoolRow(row));
}

export function getPoolsWithRecentLiquidityEvents(db: RegistryDatabase, sinceBlock: unknown) {
  return getRecentlyChangedPools(db, sinceBlock);
}

export function getPoolsMissingState(db: RegistryDatabase) {
  const sql = `
    SELECT p.*, s.last_updated_block, s.state_data
    FROM pools p
    LEFT JOIN pool_state s ON p.address = s.address
    WHERE p.status = 'active'
      AND s.address IS NULL
  `;
  return db.prepare(sql).all().map((row) => mapPoolRow(row));
}

export function getStaleStatePools(db: RegistryDatabase, staleThreshold: unknown) {
  const threshold = normalizePoolBlock(staleThreshold, "stale threshold", 0) ?? 0;
  const sql = `
    SELECT p.*
    FROM pools p
    LEFT JOIN pool_state s ON p.address = s.address
    WHERE p.status = 'active'
      AND (s.address IS NULL OR s.last_updated_block < ?)
  `;
  return db.prepare(sql).all(threshold).map((row) => mapStalePoolRow(row));
}

export function getPoolCountByProtocol(stmt: StatementFactory) {
  const rows = stmt(
    "getPoolCountByProtocol",
    `SELECT protocol, COUNT(*) as count FROM pools WHERE status = 'active' GROUP BY protocol`
  ).all() as ProtocolCountRow[];
  const result: Record<string, number> = {};
  for (const row of rows) result[String(row.protocol)] = Number(row.count ?? 0);
  return result;
}

export function loadSnapshot(batchUpsertPoolsImpl: (pools: unknown) => unknown, snapshotPath: string) {
  if (!fs.existsSync(snapshotPath)) return;
  const data = fs.readFileSync(snapshotPath, "utf8");
  const pools = parseJson(data, []);
  batchUpsertPoolsImpl(pools);
}

export function saveSnapshot(getPoolsImpl: () => unknown, snapshotPath: string) {
  const tmpPath = snapshotPath + ".tmp";
  fs.writeFileSync(tmpPath, stringifyWithBigInt(getPoolsImpl()));
  fs.renameSync(tmpPath, snapshotPath);
}

export function disablePool(
  db: RegistryDatabase,
  stmt: StatementFactory,
  invalidatePoolMetaCache: InvalidatePoolMetaCache,
  recordLiquidityEventImpl: LiquidityEventRecorder,
  poolAddress: unknown,
  reason = "manual",
) {
  const normalizedAddress = normalizeRequiredAddress(poolAddress, "pool address");

  db.transaction(() => {
    stmt("disablePool", `UPDATE pools SET status = 'disabled' WHERE address = ?`)
      .run(normalizedAddress);
    recordLiquidityEventImpl(normalizedAddress, 0, "disabled", null, reason);
  })();

  invalidatePoolMetaCache();
}

export function enablePool(
  stmt: StatementFactory,
  invalidatePoolMetaCache: InvalidatePoolMetaCache,
  poolAddress: unknown,
) {
  const normalizedAddress = normalizeRequiredAddress(poolAddress, "pool address");
  stmt("enablePool", `UPDATE pools SET status = 'active' WHERE address = ?`)
    .run(normalizedAddress);
  invalidatePoolMetaCache();
}

export function recordLiquidityEvent(
  stmt: StatementFactory,
  poolAddress: unknown,
  blockNumber: unknown,
  eventType: unknown,
  oldValue: unknown,
  newValue: unknown,
) {
  const normalizedAddress = normalizeRequiredAddress(poolAddress, "pool address");
  const normalizedBlock = normalizePoolBlock(blockNumber, "liquidity event block", 0) ?? 0;
  stmt(
    "recordLiquidityEvent",
    `INSERT INTO liquidity_events (address, block_number, event_type, old_value, new_value)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    normalizedAddress,
    normalizedBlock,
    String(eventType),
    oldValue != null ? String(oldValue) : null,
    newValue != null ? String(newValue) : null
  );
}

export function hasRecentLiquidityEvent(stmt: StatementFactory, poolAddress: unknown, sinceBlock: unknown) {
  const normalizedAddress = normalizeEvmAddress(poolAddress);
  if (!normalizedAddress) return false;
  const normalizedSinceBlock = normalizePoolBlock(sinceBlock, "liquidity event since block", 0) ?? 0;

  const row = stmt(
    "hasRecentLiquidityEvent",
    `SELECT COUNT(*) as count FROM liquidity_events
     WHERE address = ? AND block_number >= ? AND event_type != 'disabled'`
  ).get(normalizedAddress, normalizedSinceBlock) as CountRow | undefined;
  return Number(row?.count ?? 0) > 0;
}

function asLiquidityState(value: unknown): LiquidityState | null {
  return isRecord(value) ? value : null;
}

function normalizeThresholdPct(value: unknown) {
  const threshold = Number(value ?? 50);
  if (!Number.isFinite(threshold) || threshold < 0) return 50n;
  return BigInt(Math.trunc(threshold));
}

export function detectLiquidityChange(
  recordLiquidityEventImpl: LiquidityEventRecorder,
  poolAddress: unknown,
  oldState: unknown,
  newState: unknown,
  blockNumber: unknown,
  thresholdPct = 50,
) {
  const normalizedAddress = normalizeEvmAddress(poolAddress);
  if (!normalizedAddress) return false;
  const normalizedBlock = normalizePoolBlock(blockNumber, "liquidity change block", 0) ?? 0;
  const oldLiquidityState = asLiquidityState(oldState);
  const newLiquidityState = asLiquidityState(newState);
  if (!oldLiquidityState || !newLiquidityState) return false;

  let changed = false;
  const threshold = normalizeThresholdPct(thresholdPct);

  const oldReserve0 = toBigIntOrNull(oldLiquidityState.reserve0);
  const newReserve0 = toBigIntOrNull(newLiquidityState.reserve0);
  const newReserve1 = toBigIntOrNull(newLiquidityState.reserve1);
  if (oldReserve0 != null && newReserve0 != null) {
    const oldR = oldReserve0;
    const newR = newReserve0;
    if (oldR > 0n) {
      const changePct = ((newR > oldR ? newR - oldR : oldR - newR) * 100n) / oldR;
      if (changePct >= threshold) {
        recordLiquidityEventImpl(
          normalizedAddress,
          normalizedBlock,
          "large_change",
          oldR.toString(),
          newR.toString()
        );
        changed = true;
      }
    }

    if (newReserve1 != null && (newReserve0 < 1000n || newReserve1 < 1000n)) {
      recordLiquidityEventImpl(
        normalizedAddress,
        normalizedBlock,
        "near_empty",
        null,
        `${newReserve0},${newReserve1}`
      );
      changed = true;
    }
  }

  const oldLiquidity = toBigIntOrNull(oldLiquidityState.liquidity);
  const newLiquidity = toBigIntOrNull(newLiquidityState.liquidity);
  if (oldLiquidity != null && newLiquidity != null) {
    const oldL = oldLiquidity;
    const newL = newLiquidity;
    if (oldL > 0n) {
      const changePct = ((newL > oldL ? newL - oldL : oldL - newL) * 100n) / oldL;
      if (changePct >= threshold) {
        recordLiquidityEventImpl(
          normalizedAddress,
          normalizedBlock,
          "large_change",
          oldL.toString(),
          newL.toString()
        );
        changed = true;
      }
    }
  }

  return changed;
}

export function validatePoolMetadata(pool: unknown) {
  const issues: string[] = [];
  if (!isRecord(pool)) return ["unknown: pool metadata must be an object"];
  const addr = String(pool.pool_address || pool.address || "unknown");
  const protocolKey = normalizeProtocolKey(pool.protocol);

  let tokens = pool.tokens;
  if (typeof tokens === "string") {
    tokens = parseJson(tokens, []);
  }

  if (!Array.isArray(tokens) || tokens.length < 2) {
    issues.push(`${addr}: fewer than 2 tokens`);
  } else {
    const seen = new Set<string>();
    for (const t of tokens) {
      if (typeof t !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(t)) {
        issues.push(`${addr}: invalid token address: ${t}`);
        continue;
      }
      if (seen.has(t.toLowerCase())) {
        issues.push(`${addr}: duplicate token ${t}`);
      }
      seen.add(t.toLowerCase());
    }
  }

  const meta = parsePoolMetadataValue(pool.metadata);

  const isAlgebraStyleV3 = protocolKey === "QUICKSWAP_V3" || meta.isAlgebra === true;
  if (isV3Protocol(protocolKey) && !isAlgebraStyleV3) {
    if (meta.fee == null) issues.push(`${addr}: V3 pool missing fee`);
    if (meta.tickSpacing == null) issues.push(`${addr}: V3 pool missing tickSpacing`);
  }

  if (isBalancerProtocol(protocolKey)) {
    if (!meta.poolId && !meta.pool_id) {
      issues.push(`${addr}: Balancer pool missing poolId`);
    }
  }

  return issues;
}

export function validateAllPools(
  getActivePoolsImpl: () => PersistedPoolRecord[],
  validatePoolMetadataImpl: (pool: unknown) => string[],
) {
  const pools = getActivePoolsImpl();
  const invalid: Array<{ pool: PersistedPoolRecord; issues: string[] }> = [];
  if (!Array.isArray(pools)) return invalid;

  for (const pool of pools) {
    const issues = validatePoolMetadataImpl(pool);
    if (issues.length > 0) {
      invalid.push({ pool, issues });
    }
  }

  return invalid;
}