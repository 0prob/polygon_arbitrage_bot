import type { CompatDatabase } from "./sqlite.ts";
import {
  getCheckpoint as getCheckpointRecord,
  getGlobalCheckpoint as getGlobalCheckpointRecord,
  getRollbackGuard as getRollbackGuardRecord,
  rollbackToBlock as rollbackToBlockRecord,
  setCheckpoint as setCheckpointRecord,
  setRollbackGuard as setRollbackGuardRecord,
} from "./registry_checkpoints.ts";

export class RegistryCheckpointStore {
  private readonly db: CompatDatabase;
  private readonly invalidatePoolMetaCache: () => void;

  constructor(db: CompatDatabase, invalidatePoolMetaCache: () => void) {
    this.db = db;
    this.invalidatePoolMetaCache = invalidatePoolMetaCache;
  }

  getCheckpoint(protocol: string) {
    return getCheckpointRecord(this.db, protocol);
  }

  setCheckpoint(protocol: string, block: number, blockHash: string | null = null) {
    setCheckpointRecord(this.db, protocol, block, blockHash);
  }

  getGlobalCheckpoint() {
    return getGlobalCheckpointRecord(this.db);
  }

  setRollbackGuard(guard: Record<string, unknown>) {
    setRollbackGuardRecord(this.db, guard);
  }

  getRollbackGuard() {
    return getRollbackGuardRecord(this.db);
  }

  rollbackToBlock(block: number) {
    const result = rollbackToBlockRecord(this.db, block);
    this.invalidatePoolMetaCache();
    return result;
  }

  commitWatcherProgress(checkpointKey: string, checkpointBlock: number, rollbackGuard: Record<string, unknown> | null = null) {
    this.db.transaction(() => {
      setCheckpointRecord(this.db, checkpointKey, checkpointBlock, null);
      if (rollbackGuard) {
        setRollbackGuardRecord(this.db, rollbackGuard);
      }
    })();
  }

  rollbackWatcherState(checkpointKey: string, reorgBlock: number, rollbackGuard: Record<string, unknown> | null = null) {
    const result = this.db.transaction(() => {
      const rollbackResult = rollbackToBlockRecord(this.db, reorgBlock);
      setCheckpointRecord(this.db, checkpointKey, Math.max(0, reorgBlock - 1), null);
      if (rollbackGuard) {
        setRollbackGuardRecord(this.db, rollbackGuard);
      }
      return rollbackResult;
    })();
    this.invalidatePoolMetaCache();
    return result;
  }
}
