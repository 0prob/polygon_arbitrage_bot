/**
 * src/db/registry_checkpoints.js — Checkpoint, rollback-guard, and reorg helpers
 */

function checkpointStmt(db: import("./sqlite.ts").CompatDatabase, key: string, sql: string) {
  return db.statement(key, sql);
}

export function getCheckpoint(db: import("./sqlite.ts").CompatDatabase, protocol: string) {
  return (
    checkpointStmt(db, "getCheckpoint", `SELECT last_block, last_block_hash FROM checkpoints WHERE protocol = ?`).get(protocol) || null
  );
}

export function setCheckpoint(db: import("./sqlite.ts").CompatDatabase, protocol: string, block: number, blockHash: string | null = null) {
  checkpointStmt(
    db,
    "setCheckpoint",
    `INSERT INTO checkpoints (protocol, last_block, last_block_hash, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(protocol) DO UPDATE SET
         last_block      = excluded.last_block,
         last_block_hash = excluded.last_block_hash,
         updated_at      = excluded.updated_at`,
  ).run(protocol, block, blockHash);
}

export function getGlobalCheckpoint(db: import("./sqlite.ts").CompatDatabase) {
  const row = checkpointStmt(db, "getGlobalCheckpoint", `SELECT MIN(last_block) as min_block FROM checkpoints`).get();
  return row?.min_block ?? null;
}

export function setRollbackGuard(db: import("./sqlite.ts").CompatDatabase, guard: Record<string, unknown>) {
  checkpointStmt(
    db,
    "setRollbackGuard",
    `INSERT INTO rollback_guard (id, block_number, block_hash, timestamp, first_block_number, first_parent_hash)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         block_number       = excluded.block_number,
         block_hash         = excluded.block_hash,
         timestamp          = excluded.timestamp,
         first_block_number = excluded.first_block_number,
         first_parent_hash  = excluded.first_parent_hash`,
  ).run(
    (guard.blockNumber ?? guard.block_number) as number,
    (guard.hash ?? guard.block_hash) as string,
    (guard.timestamp ?? null) as number | null,
    (guard.firstBlockNumber ?? guard.first_block_number ?? null) as number | null,
    (guard.firstParentHash ?? guard.first_parent_hash ?? null) as string | null,
  );
}

export function getRollbackGuard(db: import("./sqlite.ts").CompatDatabase) {
  return (
    checkpointStmt(
      db,
      "getRollbackGuard",
      `SELECT id, block_number, block_hash, timestamp, first_block_number, first_parent_hash FROM rollback_guard WHERE id = 1`,
    ).get() || null
  );
}

export function rollbackToBlock(db: import("./sqlite.ts").CompatDatabase, block: number) {
  const deleteState = checkpointStmt(db, "rollbackDeleteState", `DELETE FROM pool_state WHERE last_updated_block >= ?`);
  const deletePools = checkpointStmt(db, "rollbackDeletePools", `DELETE FROM pools WHERE created_block >= ?`);
  const resetCheckpoints = checkpointStmt(
    db,
    "rollbackResetCheckpoints",
    `UPDATE checkpoints
     SET last_block = ?,
         last_block_hash = NULL,
         updated_at = datetime('now')
     WHERE last_block > ?`,
  );
  const reactivateRemovedPools = checkpointStmt(
    db,
    "rollbackReactivateRemovedPools",
    `UPDATE pools
     SET status = 'active',
         removed_block = NULL
     WHERE status = 'removed'
       AND removed_block >= ?`,
  );
  const deleteLiquidityEvents = checkpointStmt(db, "rollbackDeleteLiquidityEvents", `DELETE FROM liquidity_events WHERE block_number >= ?`);
  const deleteOrphanedHistory = checkpointStmt(
    db,
    "rollbackDeleteOrphanedHistory",
    `UPDATE arb_history SET status = 'orphaned' WHERE block_number >= ? AND status = 'success'`,
  );

  return db.transaction(() => {
    const stateResult = deleteState.run(block);
    const poolResult = deletePools.run(block);
    const reactivatedResult = reactivateRemovedPools.run(block);
    const liquidityEventResult = deleteLiquidityEvents.run(block);
    const orphanedResult = deleteOrphanedHistory.run(block);
    resetCheckpoints.run(block - 1, block - 1);
    return {
      poolsRemoved: poolResult.changes,
      statesRemoved: stateResult.changes,
      poolsReactivated: reactivatedResult.changes,
      liquidityEventsRemoved: liquidityEventResult.changes,
      historyOrphaned: orphanedResult.changes,
    };
  })();
}
