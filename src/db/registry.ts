/**
 * src/db/registry.js — SQLite-backed pool registry
 *
 * Responsibilities:
 *   - Pool CRUD (insert, update, remove, query)
 *   - Per-protocol checkpoint tracking for resume-from-crash
 *   - Rollback guard persistence for reorg detection
 *   - Pool state storage for swap simulation
 *   - Batch operations and snapshot I/O
 *   - Token decimals tracking
 *   - Fee tier detection and storage
 *   - Disabled pool tracking
 *   - Liquidity-change detection
 *   - Pool metadata validation
 */

import fs from "fs";
import path from "path";
import { logger } from "../utils/logger.ts";
import { CompatDatabase } from "./sqlite.ts";
import { RegistryAssetStore } from "./registry_asset_store.ts";
import { RegistryCheckpointStore } from "./registry_checkpoint_store.ts";
import { RegistryHistoryStore } from "./registry_history_store.ts";
import { RegistryMetaCache } from "./registry_meta_cache.ts";
import { RegistryPoolStore } from "./registry_pool_store.ts";
import { initRegistrySchema } from "./registry_schema.ts";

export class RegistryService {
  db: CompatDatabase;
  _assetStore: RegistryAssetStore;
  _assetCache: RegistryAssetStore["cache"];
  _checkpointStore: RegistryCheckpointStore;
  _historyStore: RegistryHistoryStore;
  _metaCache: RegistryMetaCache;
  _poolStore: RegistryPoolStore;
  _tokenMetaCache: RegistryAssetStore["cache"]["tokenMetaCache"];
  _tokenDecimalsCache: Map<string, number>;
  _poolFeeCache: RegistryAssetStore["cache"]["poolFeeCache"];
  _stmtFn: (key: string, sql: string) => ReturnType<CompatDatabase["prepare"]>;
  _invalidatePoolMetaCacheFn: () => void;
  constructor(dbPath: string) {
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    this.db = new CompatDatabase(dbPath);
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("mmap_size = 268435456"); // 256MB
    this.db.pragma("cache_size = -64000"); // 64MB
    this.db.pragma("temp_store = MEMORY");
    initRegistrySchema(this.db);
    this._stmtFn = this._stmt.bind(this);
    this._invalidatePoolMetaCacheFn = this._invalidatePoolMetaCache.bind(this);
    this._assetStore = new RegistryAssetStore(this.db);
    this._assetCache = this._assetStore.cache;
    this._metaCache = new RegistryMetaCache(this._stmtFn);
    this._checkpointStore = new RegistryCheckpointStore(this.db, this._invalidatePoolMetaCacheFn);
    this._historyStore = new RegistryHistoryStore(this.db);
    this._poolStore = new RegistryPoolStore(this.db, this._stmtFn, this._invalidatePoolMetaCacheFn);
    this._tokenMetaCache = this._assetCache.tokenMetaCache;
    this._tokenDecimalsCache = this._assetCache.tokenDecimalsCache;
    this._poolFeeCache = this._assetCache.poolFeeCache;
  }

  // ─── Pool CRUD ───────────────────────────────────────────────

  _stmt(key: string, sql: string) {
    return this.db.statement(key, sql);
  }

  _invalidatePoolMetaCache() {
    this._metaCache.invalidate();
  }

  invalidatePoolMetaCache() {
    this._invalidatePoolMetaCache();
  }

  _getPoolMetaCache() {
    return this._metaCache.getAll();
  }

  invalidateAssetCaches() {
    this._assetStore.invalidateCaches();
  }

  upsertPool(metadata: Record<string, unknown>) {
    return this._poolStore.upsertPool(metadata);
  }

  removePool(address: string) {
    return this._poolStore.removePool(address);
  }

  batchRemovePools(
    removals: Array<string | { address?: string; pool_address?: string; removed_block?: number; removedBlock?: number; block?: number }>,
  ) {
    return this._poolStore.batchRemovePools(removals);
  }

  updatePoolState(state: Record<string, unknown>) {
    return this._poolStore.updatePoolState(state);
  }

  getPools(opts = {}) {
    return this._poolStore.getPools(opts);
  }

  getActivePools() {
    return this._poolStore.getActivePools();
  }

  getActivePoolsByProtocol(protocol: string) {
    return this._poolStore.getActivePoolsByProtocol(protocol);
  }

  getHubAdjacentPools(hubTokens: Iterable<unknown>) {
    return this._poolStore.getHubAdjacentPools(hubTokens);
  }

  getActivePoolsMeta() {
    return this._metaCache.getActive();
  }

  getPoolMeta(address: string) {
    return this._metaCache.get(address);
  }

  getPool(address: string) {
    return this._poolStore.getPool(address);
  }

  getPoolCount() {
    return this._poolStore.getPoolCount();
  }

  getActivePoolCount() {
    return this._poolStore.getActivePoolCount();
  }

  getPoolCountForProtocol(protocol: string, status: string | null = null) {
    return this._poolStore.getPoolCountForProtocol(protocol, status);
  }

  getPoolAddressesForProtocol(protocol: string, status: string | null = null) {
    return this._poolStore.getPoolAddressesForProtocol(protocol, status);
  }

  // ─── Checkpoint Management ───────────────────────────────────

  getCheckpoint(protocol: string) {
    return this._checkpointStore.getCheckpoint(protocol);
  }

  setCheckpoint(protocol: string, block: number, blockHash: string | null = null) {
    this._checkpointStore.setCheckpoint(protocol, block, blockHash);
  }

  getGlobalCheckpoint() {
    return this._checkpointStore.getGlobalCheckpoint();
  }

  // ─── Rollback Guard ──────────────────────────────────────────

  setRollbackGuard(guard: Record<string, unknown>) {
    this._checkpointStore.setRollbackGuard(guard);
  }

  getRollbackGuard() {
    return this._checkpointStore.getRollbackGuard();
  }

  // ─── Rollback (Reorg) Handling ───────────────────────────────

  rollbackToBlock(block: number) {
    return this._checkpointStore.rollbackToBlock(block);
  }

  commitWatcherProgress(checkpointKey: string, checkpointBlock: number, rollbackGuard: Record<string, unknown> | null = null) {
    this._checkpointStore.commitWatcherProgress(checkpointKey, checkpointBlock, rollbackGuard);
  }

  rollbackWatcherState(checkpointKey: string, reorgBlock: number, rollbackGuard: Record<string, unknown> | null = null) {
    return this._checkpointStore.rollbackWatcherState(checkpointKey, reorgBlock, rollbackGuard);
  }

  // ─── Batch Operations ────────────────────────────────────────

  batchUpsertPools(poolList: Record<string, unknown>[]) {
    return this._poolStore.batchUpsertPools(poolList);
  }

  /**
   * Batch update pool states in a single transaction.
   *
   * @param {Array<{ pool_address: string, block: number, data: Object }>} stateList
   */
  batchUpdateStates(stateList: Record<string, unknown>[]) {
    return this._poolStore.batchUpdateStates(stateList);
  }

  /**
   * Get all active pools that have state data.
   * Returns pools joined with their latest state.
   */
  getPoolsWithState(opts = {}) {
    return this._poolStore.getPoolsWithState(opts);
  }

  getRecentlyChangedPools(sinceBlock: number) {
    return this._poolStore.getRecentlyChangedPools(sinceBlock);
  }

  getPoolsWithRecentLiquidityEvents(sinceBlock: number) {
    return this._poolStore.getPoolsWithRecentLiquidityEvents(sinceBlock);
  }

  getPoolsMissingState() {
    return this._poolStore.getPoolsMissingState();
  }

  /**
   * Get pools that need state refresh (no state or state older than given block).
   *
   * @param {number} staleThreshold  Block number; pools with state older than this are included
   * @returns {Array}
   */
  getStaleStatePools(staleThreshold: number) {
    return this._poolStore.getStaleStatePools(staleThreshold);
  }

  /**
   * Get pool count by protocol.
   * @returns {Object} e.g. { QUICKSWAP_V2: 3622, UNISWAP_V3: 3513, ... }
   */
  getPoolCountByProtocol() {
    return this._poolStore.getPoolCountByProtocol();
  }

  // ─── Snapshot I/O ────────────────────────────────────────────

  loadSnapshot(snapshotPath: string) {
    this._poolStore.loadSnapshot(snapshotPath);
  }

  saveSnapshot(snapshotPath: string) {
    this._poolStore.saveSnapshot(snapshotPath);
  }

  // ─── Token Decimals ───────────────────────────────────────────

  /**
   * Upsert token metadata (decimals, symbol, name).
   *
   * @param {string} address   Token address (lowercase)
   * @param {number} decimals  Token decimals (e.g. 18, 6, 8)
   * @param {string} [symbol]  Token symbol
   * @param {string} [name]    Token name
   */
  upsertTokenMeta(address: string, decimals: number, symbol: string | null = null, name: string | null = null) {
    this._assetStore.upsertTokenMeta(address, decimals, symbol, name);
  }

  /**
   * Get all known token addresses from the registry.
   *
   * @returns {string[]}
   */
  getAllTokenAddresses() {
    return this._assetStore.getAllTokenAddresses();
  }

  /**
   * Get token metadata for a given address.
   *
   * @param {string} address
   * @returns {{ address, decimals, symbol, name } | null}
   */
  getTokenMeta(address: string) {
    return this._assetStore.getTokenMeta(address);
  }

  /**
   * Get decimals for multiple tokens at once.
   *
   * @param {string[]} addresses
   * @returns {Map<string, number>}  address → decimals
   */
  getTokenDecimals(addresses: string[]) {
    return this._assetStore.getTokenDecimals(addresses);
  }

  /**
   * Batch upsert token metadata.
   *
   * @param {Array<{ address: string, decimals: number, symbol?: string, name?: string }>} tokens
   */
  batchUpsertTokenMeta(tokens: Array<{ address: string; decimals: number; symbol?: string; name?: string }>) {
    return this._assetStore.batchUpsertTokenMeta(tokens);
  }

  // ─── Fee Tiers ────────────────────────────────────────────────

  /**
   * Store or update the fee tier for a pool.
   *
   * @param {string} poolAddress  Lowercase pool address
   * @param {number} feeBps       Fee in basis points (e.g. 30 = 0.3%)
   * @param {string} [feeRaw]     Raw fee value from contract (e.g. "3000" for V3)
   * @param {string} [protocol]   Protocol name
   */
  upsertPoolFee(poolAddress: unknown, feeBps: unknown, feeRaw: string | null = null, protocol: string | null = null) {
    this._assetStore.upsertPoolFee(poolAddress, feeBps, feeRaw, protocol);
  }

  /**
   * Get fee tier for a pool.
   *
   * @param {string} poolAddress
   * @returns {{ feeBps: number, feeRaw: string|null } | null}
   */
  getPoolFee(poolAddress: string) {
    return this._assetStore.getPoolFee(poolAddress);
  }

  // ─── Disabled Pool Tracking ───────────────────────────────────

  /**
   * Disable a pool (soft-remove from arb consideration).
   * Sets status = 'disabled' (distinct from 'removed' which is for reorg cleanup).
   *
   * @param {string} poolAddress
   * @param {string} [reason]  Why the pool is being disabled
   */
  disablePool(poolAddress: string, reason = "manual") {
    this._poolStore.disablePool(poolAddress, reason);
    logger.warn({ event: "pool_disabled", poolAddress, reason }, `Disabled pool ${poolAddress}: ${reason}`);
  }

  /**
   * Re-enable a previously disabled pool.
   *
   * @param {string} poolAddress
   */
  enablePool(poolAddress: string) {
    this._poolStore.enablePool(poolAddress);
  }

  /**
   * Get all disabled pools.
   *
   * @returns {Array}
   */
  getDisabledPools() {
    return this._poolStore.getDisabledPools();
  }

  // ─── Liquidity Change Detection ───────────────────────────────

  /**
   * Record a liquidity event for a pool.
   *
   * @param {string} poolAddress
   * @param {number} blockNumber
   * @param {string} eventType   'large_change' | 'near_empty' | 'disabled'
   * @param {*}      [oldValue]  Previous value
   * @param {*}      [newValue]  New value
   */
  recordLiquidityEvent(poolAddress: string, blockNumber: number, eventType: string, oldValue: unknown, newValue: unknown) {
    this._poolStore.recordLiquidityEvent(poolAddress, blockNumber, eventType, oldValue, newValue);
  }

  /**
   * Check if a pool has had a large liquidity change recently.
   *
   * @param {string} poolAddress
   * @param {number} sinceBlock  Only look at events after this block
   * @returns {boolean}
   */
  hasRecentLiquidityEvent(poolAddress: string, sinceBlock: number) {
    return this._poolStore.hasRecentLiquidityEvent(poolAddress, sinceBlock);
  }

  /**
   * Detect and record large liquidity changes given new vs old state.
   *
   * For V2 pools: checks if reserves changed by more than threshold%.
   * For V3 pools: checks if liquidity changed by more than threshold%.
   *
   * @param {string} poolAddress
   * @param {Object} oldState   Previous canonical state
   * @param {Object} newState   New canonical state
   * @param {number} blockNumber
   * @param {number} [thresholdPct=50]  % change threshold
   * @returns {boolean}  true if a significant change was detected
   */
  detectLiquidityChange(poolAddress: string, oldState: unknown, newState: unknown, blockNumber: number, thresholdPct = 50) {
    return this._poolStore.detectLiquidityChange(poolAddress, oldState, newState, blockNumber, thresholdPct);
  }

  // ─── Metadata Validation ──────────────────────────────────────

  /**
   * Validate pool metadata and return a list of issues found.
   *
   * Checks:
   *   - tokens array has >= 2 entries
   *   - token addresses are valid (42-char 0x hex)
   *   - no duplicate tokens
   *   - V3 pools have fee and tickSpacing
   *   - Balancer pools have poolId
   *
   * @param {Object} pool  Registry pool record
   * @returns {string[]}   Array of validation issue strings (empty = valid)
   */
  validatePoolMetadata(pool: unknown) {
    return this._poolStore.validatePoolMetadata(pool);
  }

  /**
   * Validate all active pools and return pools with issues.
   *
   * @returns {Array<{ pool: Object, issues: string[] }>}
   */
  validateAllPools() {
    return this._poolStore.validateAllPools();
  }

  // ─── Arbitrage History ────────────────────────────────────────

  /**
   * Log a completed arbitrage execution to the history table.
   *
   * @param {Object} arb
   * @param {string}   [arb.txHash]        Transaction hash (null if not yet confirmed)
   * @param {number}   [arb.blockNumber]   Block the arb was included in
   * @param {string}    arb.startToken     Start/end token address (lowercase)
   * @param {number}    arb.hopCount       Number of hops (2, 3, or 4)
   * @param {bigint}    arb.amountIn       Input amount
   * @param {bigint}    arb.amountOut      Output amount
   * @param {bigint}    arb.grossProfit    Gross profit (amountOut - amountIn)
   * @param {bigint}    arb.netProfit      Net profit after gas/slippage
   * @param {number}   [arb.gasUsed]       Actual gas consumed
   * @param {bigint}   [arb.gasPriceWei]   Gas price at execution time
   * @param {string[]}  arb.pools          Ordered list of pool addresses
   * @param {string[]}  arb.protocols      Ordered list of protocol names
   * @param {string}   [arb.status]        'success' | 'reverted' | 'dropped'
   */
  logArbResult(arb: Record<string, unknown>) {
    this._historyStore.logArbResult(arb);
  }

  /**
   * Retrieve recent arb history entries.
   *
   * @param {Object} [opts]
   * @param {number}  [opts.limit=100]     Max rows to return
   * @param {string}  [opts.startToken]    Filter by start token
   * @param {string}  [opts.status]        Filter by status ('success' | 'reverted' | 'dropped')
   * @param {string}  [opts.since]         ISO datetime lower bound for recorded_at
   * @returns {Array<Object>}
   */
  getArbHistory(opts: Record<string, unknown> = {}) {
    return this._historyStore.getArbHistory(opts);
  }

  /**
   * Get aggregate profit statistics across all recorded arbs.
   *
   * Returns total/average net profit for successful arbs,
   * along with counts per status and per hop count.
   *
   * @param {Object} [opts]
   * @param {string} [opts.since]  ISO datetime lower bound
   * @returns {Object}
   */
  getArbStats(opts: Record<string, unknown> = {}) {
    return this._historyStore.getArbStats(opts);
  }

  // ─── Lifecycle ───────────────────────────────────────────────

  close() {
    this._metaCache.invalidate();
    this.db.close();
  }
}
