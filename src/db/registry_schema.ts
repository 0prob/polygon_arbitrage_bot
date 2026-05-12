import type { CompatDatabase } from "./sqlite.ts";

const SCHEMA_VERSION = 2;

const REGISTRY_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS pools (
    address TEXT PRIMARY KEY,
    protocol TEXT NOT NULL,
    tokens TEXT NOT NULL,
    created_block INTEGER NOT NULL,
    created_tx TEXT NOT NULL,
    metadata TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    removed_block INTEGER
  );

  CREATE TABLE IF NOT EXISTS pool_state (
    address TEXT PRIMARY KEY,
    last_updated_block INTEGER NOT NULL,
    state_data TEXT NOT NULL,
    FOREIGN KEY (address) REFERENCES pools(address)
  );

  CREATE TABLE IF NOT EXISTS checkpoints (
    protocol TEXT PRIMARY KEY,
    last_block INTEGER NOT NULL,
    last_block_hash TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS rollback_guard (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    block_number INTEGER NOT NULL,
    block_hash TEXT NOT NULL,
    timestamp INTEGER,
    first_block_number INTEGER,
    first_parent_hash TEXT
  );

  CREATE TABLE IF NOT EXISTS token_meta (
    address TEXT PRIMARY KEY,
    decimals INTEGER NOT NULL,
    symbol TEXT,
    name TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS pool_fees (
    address TEXT PRIMARY KEY,
    fee_bps INTEGER NOT NULL,
    fee_raw TEXT,
    protocol TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS liquidity_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    address TEXT NOT NULL,
    block_number INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS arb_history (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    tx_hash          TEXT,
    block_number     INTEGER,
    start_token      TEXT NOT NULL,
    hop_count        INTEGER NOT NULL,
    amount_in        TEXT NOT NULL,
    amount_out       TEXT NOT NULL,
    gross_profit     TEXT NOT NULL,
    net_profit       TEXT NOT NULL,
    gas_used         INTEGER,
    gas_price_wei    TEXT,
    pools            TEXT NOT NULL,
    protocols        TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'success',
    recorded_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

`;

const REGISTRY_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_pools_protocol ON pools(protocol);
  CREATE INDEX IF NOT EXISTS idx_pools_status ON pools(status);
  CREATE INDEX IF NOT EXISTS idx_pools_status_protocol ON pools(status, protocol);
  CREATE INDEX IF NOT EXISTS idx_pool_state_block ON pool_state(last_updated_block);
  CREATE INDEX IF NOT EXISTS idx_liquidity_events_addr ON liquidity_events(address);
  CREATE INDEX IF NOT EXISTS idx_liquidity_events_addr_block ON liquidity_events(address, block_number);
  CREATE INDEX IF NOT EXISTS idx_arb_history_recorded ON arb_history(recorded_at);
  CREATE INDEX IF NOT EXISTS idx_arb_history_token ON arb_history(start_token);
  CREATE INDEX IF NOT EXISTS idx_arb_history_status ON arb_history(status);
  CREATE INDEX IF NOT EXISTS idx_pools_created_block ON pools(created_block);
  CREATE INDEX IF NOT EXISTS idx_pools_removed_block ON pools(removed_block);
  CREATE INDEX IF NOT EXISTS idx_pools_protocol_status ON pools(protocol, status);
  CREATE INDEX IF NOT EXISTS idx_liquidity_events_block ON liquidity_events(block_number);
`;

type ColumnInfo = { name: string };

function hasColumn(db: CompatDatabase, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
  return cols.some((c) => c.name === column);
}

export function initRegistrySchema(db: CompatDatabase) {
  db.exec(REGISTRY_TABLES_SQL);

  const currentVersion = Number(db.pragmaGet<{ user_version: number }>("user_version")?.user_version ?? 0);

  if (currentVersion < 2) {
    if (!hasColumn(db, "pools", "status")) {
      db.exec(`ALTER TABLE pools ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
    }
    if (!hasColumn(db, "pools", "removed_block")) {
      db.exec(`ALTER TABLE pools ADD COLUMN removed_block INTEGER`);
    }
  }

  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

  db.exec(REGISTRY_INDEXES_SQL);
}
