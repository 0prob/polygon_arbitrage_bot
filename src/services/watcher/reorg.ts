import { asRecord } from "../../core/utils/errors.ts";
import type { CompatDatabase } from "../../infra/db/connection.ts";
import { getCheckpoint, saveCheckpoint } from "../../infra/db/checkpoints.ts";

export type RollbackGuard = Record<string, unknown>;

export type ReorgResult =
  | { reorgDetected: false }
  | { reorgDetected: true; reorgBlock: number; checkpointBlock: number; statesRemoved: number };

function pick(obj: unknown, camelKey: string, snakeKey: string) {
  const r = asRecord(obj);
  if (!r) return undefined;
  return r[camelKey] ?? r[snakeKey];
}

function storedRollbackGuard(registry: { getRollbackGuard?: () => unknown }): Record<string, unknown> | null {
  if (typeof registry.getRollbackGuard !== "function") return null;
  const guard = registry.getRollbackGuard();
  const rec = asRecord(guard);
  return rec ? rec : null;
}

function detectReorg(registry: { getRollbackGuard?: () => unknown }, newGuard: unknown): number | false {
  if (!newGuard) return false;
  const stored = storedRollbackGuard(registry);
  if (!stored) return false;
  const storedHash = stored.block_hash;
  const storedBlock = Number(stored.block_number);
  const storedFirstBlock = Number(pick(stored, "firstBlockNumber", "first_block_number"));
  const storedFirstParent = pick(stored, "firstParentHash", "first_parent_hash");
  const newFirstParent = pick(newGuard, "firstParentHash", "first_parent_hash") as string | undefined;
  const newFirstBlockRaw = pick(newGuard, "firstBlockNumber", "first_block_number");
  const newFirstBlock = Number(newFirstBlockRaw);
  if (!Number.isFinite(newFirstBlock) || !newFirstParent) return false;
  if (newFirstBlock === storedBlock && newFirstParent && storedHash) {
    if (newFirstParent !== storedHash) return storedBlock;
  }
  if (Number.isFinite(storedFirstBlock) && newFirstBlock === storedFirstBlock && storedFirstParent && newFirstParent !== storedFirstParent) {
    return newFirstBlock;
  }
  return false;
}

export function checkReorg(
  db: CompatDatabase,
  registry: { getRollbackGuard?: () => unknown; setRollbackGuard?: (guard: RollbackGuard) => unknown },
  rollbackGuard: RollbackGuard | null | undefined,
): ReorgResult {
  if (!rollbackGuard) return { reorgDetected: false };
  const reorgBlock = detectReorg(registry, rollbackGuard);
  if (reorgBlock === false) {
    registry.setRollbackGuard?.(rollbackGuard);
    return { reorgDetected: false };
  }
  const checkpointBlock = Math.max(0, reorgBlock - 1);
  const statesRemoved = rollbackToBlock(db, "HYPERSYNC_WATCHER", checkpointBlock);
  registry.setRollbackGuard?.(rollbackGuard);
  return { reorgDetected: true, reorgBlock, checkpointBlock, statesRemoved };
}

export function rollbackToBlock(db: CompatDatabase, checkpointKey: string, targetBlock: number): number {
  const checkpoint = getCheckpoint(db, checkpointKey);
  if (!checkpoint) return 0;
  const stmt = db.statement("rollbackRemoveState", "DELETE FROM pool_state WHERE last_updated_block >= ?");
  const result = stmt.run(targetBlock);
  return Number(result.changes ?? 0);
}

export function saveWatcherCheckpoint(db: CompatDatabase, blockNumber: number, blockHash: string) {
  saveCheckpoint(db, "HYPERSYNC_WATCHER", blockNumber, blockHash);
}
