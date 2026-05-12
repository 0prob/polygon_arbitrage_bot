import type { CompatDatabase } from "./sqlite.ts";
import {
  getArbHistory as getArbHistoryRecord,
  getArbStats as getArbStatsRecord,
  logArbResult as logArbResultRecord,
} from "./registry_history.ts";

export class RegistryHistoryStore {
  private readonly db: CompatDatabase;

  constructor(db: CompatDatabase) {
    this.db = db;
  }

  logArbResult(arb: Record<string, unknown>) {
    logArbResultRecord(this.db, arb);
  }

  getArbHistory(opts: Record<string, unknown> = {}) {
    return getArbHistoryRecord(this.db, opts);
  }

  getArbStats(opts: Record<string, unknown> = {}) {
    return getArbStatsRecord(this.db, opts);
  }
}
