import type { CompatDatabase } from "./sqlite.ts";
import {
  batchRemovePools as batchRemovePoolsRecord,
  batchUpdateStates as batchUpdateStatesRecord,
  batchUpsertPools as batchUpsertPoolsRecord,
  detectLiquidityChange as detectLiquidityChangeRecord,
  disablePool as disablePoolRecord,
  enablePool as enablePoolRecord,
  getActivePoolCount as getActivePoolCountRecord,
  getActivePoolsByProtocol as getActivePoolsByProtocolRecord,
  getHubAdjacentPools as getHubAdjacentPoolsRecord,
  getPool as getPoolRecord,
  getPoolAddressesForProtocol as getPoolAddressesForProtocolRecord,
  getPoolCount as getPoolCountRecord,
  getPoolCountByProtocol as getPoolCountByProtocolRecord,
  getPoolCountForProtocol as getPoolCountForProtocolRecord,
  getPools as getPoolsRecord,
  getPoolsWithState as getPoolsWithStateRecord,
  getPoolsMissingState as getPoolsMissingStateRecord,
  getPoolsWithRecentLiquidityEvents as getPoolsWithRecentLiquidityEventsRecord,
  getRecentlyChangedPools as getRecentlyChangedPoolsRecord,
  getStaleStatePools as getStaleStatePoolsRecord,
  hasRecentLiquidityEvent as hasRecentLiquidityEventRecord,
  loadSnapshot as loadSnapshotRecord,
  recordLiquidityEvent as recordLiquidityEventRecord,
  removePool as removePoolRecord,
  saveSnapshot as saveSnapshotRecord,
  updatePoolState as updatePoolStateRecord,
  upsertPool as upsertPoolRecord,
  validateAllPools as validateAllPoolsRecord,
  validatePoolMetadata as validatePoolMetadataRecord,
} from "./registry_pools.ts";

type StatementGetter = (key: string, sql: string) => ReturnType<CompatDatabase["prepare"]>;

export class RegistryPoolStore {
  private readonly db: CompatDatabase;
  private readonly stmt: StatementGetter;
  private readonly invalidatePoolMetaCache: () => void;
  private readonly recordLiquidityEventFn: (...args: unknown[]) => void;

  constructor(
    db: CompatDatabase,
    stmt: StatementGetter,
    invalidatePoolMetaCache: () => void,
  ) {
    this.db = db;
    this.stmt = stmt;
    this.invalidatePoolMetaCache = invalidatePoolMetaCache;
    this.recordLiquidityEventFn = this.recordLiquidityEvent.bind(this);
  }

  upsertPool(metadata: Record<string, unknown>) {
    return upsertPoolRecord(this.stmt, this.invalidatePoolMetaCache, metadata);
  }

  removePool(address: string) {
    return removePoolRecord(this.stmt, this.invalidatePoolMetaCache, address);
  }

  batchRemovePools(removals: Array<string | Record<string, unknown>>) {
    return batchRemovePoolsRecord(this.stmt, this.invalidatePoolMetaCache, this.db, removals);
  }

  updatePoolState(state: Record<string, unknown>) {
    return updatePoolStateRecord(this.stmt, state);
  }

  getPools(opts = {}) {
    return getPoolsRecord(this.db, opts);
  }

  getActivePools() {
    return this.getPools({ status: "active" });
  }

  getActivePoolsByProtocol(protocol: string) {
    return getActivePoolsByProtocolRecord(this.db, protocol);
  }

  getHubAdjacentPools(hubTokens: Iterable<unknown>) {
    return getHubAdjacentPoolsRecord(this.db, hubTokens);
  }

  getPool(address: string) {
    return getPoolRecord(this.stmt, address);
  }

  getPoolCount() {
    return getPoolCountRecord(this.stmt);
  }

  getActivePoolCount() {
    return getActivePoolCountRecord(this.stmt);
  }

  getPoolCountForProtocol(protocol: string, status: string | null = null) {
    return getPoolCountForProtocolRecord(this.stmt, protocol, status);
  }

  getPoolAddressesForProtocol(protocol: string, status: string | null = null) {
    return getPoolAddressesForProtocolRecord(this.stmt, protocol, status);
  }

  batchUpsertPools(poolList: unknown) {
    return batchUpsertPoolsRecord(this.db, this.stmt, this.invalidatePoolMetaCache, poolList);
  }

  batchUpdateStates(stateList: unknown) {
    return batchUpdateStatesRecord(this.db, this.stmt, stateList);
  }

  getPoolsWithState(opts = {}) {
    return getPoolsWithStateRecord(this.db, opts);
  }

  getRecentlyChangedPools(sinceBlock: unknown) {
    return getRecentlyChangedPoolsRecord(this.db, sinceBlock);
  }

  getPoolsWithRecentLiquidityEvents(sinceBlock: unknown) {
    return getPoolsWithRecentLiquidityEventsRecord(this.db, sinceBlock);
  }

  getPoolsMissingState() {
    return getPoolsMissingStateRecord(this.db);
  }

  getStaleStatePools(staleThreshold: number) {
    return getStaleStatePoolsRecord(this.db, staleThreshold);
  }

  getPoolCountByProtocol() {
    return getPoolCountByProtocolRecord(this.stmt);
  }

  loadSnapshot(snapshotPath: string) {
    loadSnapshotRecord(this.batchUpsertPools.bind(this), snapshotPath);
  }

  saveSnapshot(snapshotPath: string) {
    saveSnapshotRecord(this.getPools.bind(this), snapshotPath);
  }

  disablePool(poolAddress: unknown, reason = "manual") {
    disablePoolRecord(
      this.db,
      this.stmt,
      this.invalidatePoolMetaCache,
      this.recordLiquidityEventFn,
      poolAddress,
      reason,
    );
  }

  enablePool(poolAddress: unknown) {
    enablePoolRecord(this.stmt, this.invalidatePoolMetaCache, poolAddress);
  }

  getDisabledPools() {
    return this.getPools({ status: "disabled" });
  }

  recordLiquidityEvent(poolAddress: unknown, blockNumber: unknown, eventType: unknown, oldValue: unknown, newValue: unknown) {
    recordLiquidityEventRecord(this.stmt, poolAddress, blockNumber, eventType, oldValue, newValue);
  }

  hasRecentLiquidityEvent(poolAddress: unknown, sinceBlock: unknown) {
    return hasRecentLiquidityEventRecord(this.stmt, poolAddress, sinceBlock);
  }

  detectLiquidityChange(
    poolAddress: unknown,
    oldState: unknown,
    newState: unknown,
    blockNumber: unknown,
    thresholdPct = 50,
  ) {
    return detectLiquidityChangeRecord(
      this.recordLiquidityEventFn,
      poolAddress,
      oldState,
      newState,
      blockNumber,
      thresholdPct,
    );
  }

  validatePoolMetadata(pool: unknown) {
    return validatePoolMetadataRecord(pool);
  }

  validateAllPools() {
    return validateAllPoolsRecord(
      this.getActivePools.bind(this),
      this.validatePoolMetadata.bind(this),
    );
  }
}
