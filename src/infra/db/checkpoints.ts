import type { CompatDatabase } from "./connection.ts";

export function saveCheckpoint(db: CompatDatabase, id: string, blockNumber: number, blockHash: string) {
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.statement(
    "saveCheckpoint",
    `INSERT OR REPLACE INTO checkpoints (id, block_number, block_hash, created_at)
     VALUES (?, ?, ?, ?)`,
  );
  return stmt.run(id, blockNumber, blockHash, now);
}

export function getCheckpoint(db: CompatDatabase, id: string) {
  const stmt = db.statement("getCheckpoint", `SELECT * FROM checkpoints WHERE id = ?`);
  return (stmt.get(id) as Record<string, unknown> | undefined) ?? null;
}

export function getLatestCheckpoint(db: CompatDatabase) {
  const stmt = db.statement("getLatestCheckpoint", `SELECT * FROM checkpoints ORDER BY created_at DESC LIMIT 1`);
  return (stmt.get() as Record<string, unknown> | undefined) ?? null;
}
