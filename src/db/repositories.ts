import type { RegistryService } from "./registry.ts";

export type RegistryPoolRecord = {
  pool_address: string;
  protocol: string;
  tokens: unknown;
  metadata?: unknown;
  status?: string;
  state?: { data?: Record<string, unknown> } | null;
  [key: string]: unknown;
};

export type RegistryTokenMeta = {
  address: string;
  decimals: number;
  symbol?: string | null;
  name?: string | null;
};

export type RegistryPoolStateUpdate = {
  pool_address: string;
  block: number;
  data: Record<string, unknown>;
};

export type RegistryCheckpoint = {
  protocol?: string;
  last_block: number;
  last_block_hash?: string | null;
  updated_at?: string;
};

export type RegistryRollbackGuard = Record<string, unknown>;

export type RegistryMutationSummary = {
  upserted?: number;
  updated?: number;
  removed?: number;
  skipped?: number;
  [key: string]: unknown;
};

export type RegistryRollbackSummary = {
  poolsRemoved: number;
  statesRemoved: number;
  liquidityEventsRemoved?: number;
  [key: string]: unknown;
};

export type RegistryPoolRepository = {
  getAll(opts?: Record<string, unknown>): RegistryPoolRecord[];
  getActive(): RegistryPoolRecord[];
  getActiveByProtocol(protocol: string): RegistryPoolRecord[];
  getActiveMeta(): RegistryPoolRecord[];
  getHubAdjacent(hubTokens: Iterable<unknown>): RegistryPoolRecord[];
  getMeta(address: string): RegistryPoolRecord | undefined;
  get(address: string): RegistryPoolRecord | null;
  getCount(): number;
  getActiveCount(): number;
  getCountForProtocol(protocol: string, status?: string | null): number;
  getCountByProtocol(): Record<string, number>;
  getAddressesForProtocol(protocol: string, status?: string | null): string[];
  getWithState(opts?: Record<string, unknown>): RegistryPoolRecord[];
  getRecentlyChanged(sinceBlock: number): RegistryPoolRecord[];
  getWithRecentLiquidityEvents(sinceBlock: number): RegistryPoolRecord[];
  getMissingState(): RegistryPoolRecord[];
  getStaleState(staleThreshold: number): RegistryPoolRecord[];
  batchUpsert(pools: RegistryPoolRecord[]): RegistryMutationSummary;
  batchUpdateStates(states: RegistryPoolStateUpdate[]): RegistryMutationSummary;
  updateState(state: RegistryPoolStateUpdate): unknown;
  remove(address: string): unknown;
  batchRemove(removals: Array<string | Record<string, unknown>>): number;
  disable(address: string, reason: string): unknown;
  enable(address: string): unknown;
  getDisabled(): RegistryPoolRecord[];
  invalidateMetaCache(): void;
};

export type RegistryCheckpointRepository = {
  get(key: string): RegistryCheckpoint | null;
  getGlobalBlock(): number | null;
  set(key: string, block: number, blockHash?: string | null): void;
  getRollbackGuard(): RegistryRollbackGuard | null;
  setRollbackGuard(guard: RegistryRollbackGuard): void;
  rollbackToBlock(block: number): RegistryRollbackSummary;
  commitWatcherProgress(checkpointKey: string, checkpointBlock: number, rollbackGuard?: RegistryRollbackGuard | null): void;
  rollbackWatcherState(checkpointKey: string, reorgBlock: number, rollbackGuard?: RegistryRollbackGuard | null): RegistryRollbackSummary;
};

export type RegistryTokenRepository = {
  getMeta(address: string): RegistryTokenMeta | null;
  getDecimals(addresses: string[]): Map<string, number>;
  upsertMeta(address: string, decimals: number, symbol?: string | null, name?: string | null): void;
  batchUpsertMeta(rows: RegistryTokenMeta[]): RegistryMutationSummary;
};

export type RegistryFeeRepository = {
  getPoolFee(poolAddress: string): { feeBps: number; feeRaw: string | null } | null;
  upsertPoolFee(poolAddress: string, feeBps: number, feeRaw?: string | null, protocol?: string | null): void;
};

export type RegistryHistoryRepository = {
  logArbResult(arb: Record<string, unknown>): void;
  getArbHistory(opts?: Record<string, unknown>): Array<Record<string, unknown>>;
  getArbStats(opts?: Record<string, unknown>): Record<string, unknown>;
};

export type RegistryMaintenanceRepository = {
  validatePoolMetadata(pool: RegistryPoolRecord): string[];
  validateAllPools(): Array<{ pool: RegistryPoolRecord; issues: string[] }>;
  loadSnapshot(snapshotPath: string): void;
  saveSnapshot(snapshotPath: string): void;
  invalidateAssetCaches(): void;
  close(): void;
};

export type RegistryRepositories = {
  pools: RegistryPoolRepository;
  checkpoints: RegistryCheckpointRepository;
  tokens: RegistryTokenRepository;
  fees: RegistryFeeRepository;
  history: RegistryHistoryRepository;
  maintenance: RegistryMaintenanceRepository;
};

export function createRegistryRepositories(registry: RegistryService): RegistryRepositories {
  return {
    pools: {
      getAll: (opts) => registry.getPools(opts),
      getActive: () => registry.getActivePools(),
      getActiveByProtocol: (protocol) => registry.getActivePoolsByProtocol(protocol),
      getActiveMeta: () => registry.getActivePoolsMeta(),
      getHubAdjacent: (hubTokens) => registry.getHubAdjacentPools(hubTokens),
      getMeta: (address) => registry.getPoolMeta(address),
      get: (address) => registry.getPool(address) as RegistryPoolRecord | null,
      getCount: () => registry.getPoolCount(),
      getActiveCount: () => registry.getActivePoolCount(),
      getCountForProtocol: (protocol, status = null) => registry.getPoolCountForProtocol(protocol, status),
      getCountByProtocol: () => registry.getPoolCountByProtocol(),
      getAddressesForProtocol: (protocol, status = null) => registry.getPoolAddressesForProtocol(protocol, status),
      getWithState: (opts) => registry.getPoolsWithState(opts),
      getRecentlyChanged: (sinceBlock) => registry.getRecentlyChangedPools(sinceBlock),
      getWithRecentLiquidityEvents: (sinceBlock) => registry.getPoolsWithRecentLiquidityEvents(sinceBlock),
      getMissingState: () => registry.getPoolsMissingState(),
      getStaleState: (staleThreshold) => registry.getStaleStatePools(staleThreshold),
      batchUpsert: (pools) => registry.batchUpsertPools(pools),
      batchUpdateStates: (states) => registry.batchUpdateStates(states),
      updateState: (state) => registry.updatePoolState(state),
      remove: (address) => registry.removePool(address),
      batchRemove: (removals) => registry.batchRemovePools(removals),
      disable: (address, reason) => registry.disablePool(address, reason),
      enable: (address) => registry.enablePool(address),
      getDisabled: () => registry.getDisabledPools(),
      invalidateMetaCache: () => registry.invalidatePoolMetaCache(),
    },
    checkpoints: {
      get: (key) => registry.getCheckpoint(key) as RegistryCheckpoint | null,
      getGlobalBlock: () => registry.getGlobalCheckpoint() as number | null,
      set: (key, block, blockHash = null) => registry.setCheckpoint(key, block, blockHash),
      getRollbackGuard: () => registry.getRollbackGuard(),
      setRollbackGuard: (guard) => registry.setRollbackGuard(guard),
      rollbackToBlock: (block) => registry.rollbackToBlock(block) as RegistryRollbackSummary,
      commitWatcherProgress: (checkpointKey, checkpointBlock, rollbackGuard = null) =>
        registry.commitWatcherProgress(checkpointKey, checkpointBlock, rollbackGuard),
      rollbackWatcherState: (checkpointKey, reorgBlock, rollbackGuard = null) =>
        registry.rollbackWatcherState(checkpointKey, reorgBlock, rollbackGuard) as RegistryRollbackSummary,
    },
    tokens: {
      getMeta: (address) => registry.getTokenMeta(address) as RegistryTokenMeta | null,
      getDecimals: (addresses) => registry.getTokenDecimals(addresses),
      upsertMeta: (address, decimals, symbol = null, name = null) =>
        registry.upsertTokenMeta(address, decimals, symbol, name),
      batchUpsertMeta: (rows) => registry.batchUpsertTokenMeta(
        rows.map((row) => ({
          ...row,
          symbol: row.symbol ?? undefined,
          name: row.name ?? undefined,
        })),
      ),
    },
    fees: {
      getPoolFee: (poolAddress) => registry.getPoolFee(poolAddress),
      upsertPoolFee: (poolAddress, feeBps, feeRaw = null, protocol = null) =>
        registry.upsertPoolFee(poolAddress, feeBps, feeRaw, protocol),
    },
    history: {
      logArbResult: (arb) => registry.logArbResult(arb),
      getArbHistory: (opts) => registry.getArbHistory(opts),
      getArbStats: (opts) => registry.getArbStats(opts),
    },
    maintenance: {
      validatePoolMetadata: (pool) => registry.validatePoolMetadata(pool),
      validateAllPools: () => registry.validateAllPools(),
      loadSnapshot: (snapshotPath) => registry.loadSnapshot(snapshotPath),
      saveSnapshot: (snapshotPath) => registry.saveSnapshot(snapshotPath),
      invalidateAssetCaches: () => registry.invalidateAssetCaches(),
      close: () => registry.close(),
    },
  };
}
