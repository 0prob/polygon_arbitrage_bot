/**
 * src/state/watcher.ts — HyperSync Event Watcher
 *
 * Replaces RPC polling with a live HyperSync loop built on `client.get()`.
 *
 * Why not `stream` / `streamEvents` here?
 *   The uploaded HyperSync documentation warns that stream/collect helpers
 *   are not designed for use at the chain tip where rollbacks may occur.
 *   This watcher therefore implements a manual polling loop over `get()` and
 *   handles `rollbackGuard` explicitly.
 */

import { client, Decoder } from "../hypersync/client.ts";
import type { HyperSyncGetResponse } from "../hypersync/query_policy.ts";
import type { HyperSyncRawLog } from "../hypersync/logs.ts";
import { buildWatcherLogQueries, WATCHER_SIGNATURES, watcherFilterMode } from "./watcher_query.ts";
import { HYPERSYNC_TARGETED_BACKFILL_LOOKBACK_BLOCKS, HYPERSYNC_TARGETED_BACKFILL_MAX_POOLS } from "../config/index.ts";
import { updateWatcherAddressFilter } from "./watcher_filter.ts";
import { initializeWatcherStart, WATCHER_LOOKBACK_BLOCKS, type WatcherStartRegistry } from "./watcher_startup.ts";
import { waitForWatcherHeightAdvance, WATCHER_IDLE_SLEEP_MS } from "./watcher_height_wait.ts";
import { WatcherSleeper } from "./watcher_sleep.ts";
import { pollWatcherOnce, type WatcherPollResponse } from "./watcher_polling.ts";
import { WatcherPollErrorTracker } from "./watcher_poll_errors.ts";
import {
  clearPendingWatcherEnrichment,
  enqueueWatcherEnrichment,
  type EpochWatcherEnrichmentTask,
  type PendingWatcherEnrichment,
  type WatcherEnrichmentRetryState,
} from "./watcher_enrichment.ts";
import { handleWatcherPollResponse, runWatcherLoop, type WatcherLoopRegistry } from "./watcher_loop.ts";
import {
  createWatcherRuntimeAdapters,
  type WatcherRuntimeDecoder,
  type WatcherRuntimeLogHandler,
  type WatcherRuntimeRegistry,
  type WatcherRuntimeStateAdapters,
} from "./watcher_runtime_adapters.ts";
import { logger } from "../utils/logger.ts";
import type { WatcherEnrichmentTask } from "./watcher_types.ts";
import type { RouteStateCache } from "../routing/simulation_types.ts";
export { WATCHER_TOPIC0 } from "./watcher_query.ts";
export {
  classifyWatcherPollError,
  dedupeWatcherLogs,
  sortWatcherLogs,
  watcherCheckpointFromNextBlock,
  watcherErrorBackoffMeta,
  watcherErrorBackoffMs,
  watcherHaltMeta,
  watcherProgressMeta,
  watcherReorgMeta,
  watcherShardArchiveHeightMeta,
  watcherShouldHaltAfterIntegrityError,
} from "./watcher_poll_utils.ts";

export const watcherLogger = logger.child({ component: "watcher" });

type WatcherRegistry = WatcherStartRegistry & WatcherRuntimeRegistry & WatcherLoopRegistry;

export class StateWatcher {
  private _registry: WatcherRegistry;
  private _cache: RouteStateCache;
  private _decoder: WatcherRuntimeDecoder;
  private _running: boolean;
  private _closed: boolean;
  private _lastBlock: number;
  private _checkpointKey: string;
  private _loopPromise: Promise<void> | null;
  private _watchedAddresses: string[];
  private _watchedAddressSet: Set<string>;
  private _pendingEnrichment: Map<string, PendingWatcherEnrichment>;
  private _enrichmentRetryState: Map<string, WatcherEnrichmentRetryState>;
  private _enrichmentEpoch: number;
  private _sleeper: WatcherSleeper;
  private _stateAdapters: WatcherRuntimeStateAdapters;
  private _logHandler: WatcherRuntimeLogHandler;
  private _pollErrors: WatcherPollErrorTracker;
  onBatch: ((batch: unknown) => void) | null;
  onReorg: ((reorg: unknown) => void) | null;
  onHalt: ((event: Record<string, unknown>) => void) | null;

  constructor(registry: unknown, stateCache: RouteStateCache) {
    this._registry = registry as WatcherRegistry;
    this._cache = stateCache;
    this._decoder = Decoder.fromSignatures(WATCHER_SIGNATURES) as WatcherRuntimeDecoder;
    this._running = false;
    this._closed = false;
    this._lastBlock = 0;
    this._checkpointKey = "HYPERSYNC_WATCHER";
    this._loopPromise = null;
    this._watchedAddresses = [];
    this._watchedAddressSet = new Set();
    this._pendingEnrichment = new Map();
    this._enrichmentRetryState = new Map();
    this._enrichmentEpoch = 0;
    this._sleeper = new WatcherSleeper();
    const runtimeAdapters = createWatcherRuntimeAdapters({
      registry: this._registry,
      cache: this._cache,
      pendingEnrichment: this._pendingEnrichment,
      getLastBlock: () => this._lastBlock,
      getEpoch: () => this._enrichmentEpoch,
      setEpoch: (epoch) => {
        this._enrichmentEpoch = epoch;
      },
      isClosed: () => this._closed,
      isCurrentEpoch: (epoch) => epoch === this._enrichmentEpoch,
      setAddressFilter: (filter) => {
        this._watchedAddresses = filter.addresses;
        this._watchedAddressSet = filter.addressSet;
      },
      enqueueEnrichment: this._enqueueEnrichment.bind(this),
      decoder: {
        decodeLogs: (logs) => this._decoder.decodeLogs(logs),
      },
    });
    this._stateAdapters = runtimeAdapters.stateAdapters;
    this._logHandler = runtimeAdapters.logHandler;
    this._pollErrors = new WatcherPollErrorTracker();

    this.onBatch = null;
    this.onReorg = null;
    this.onHalt = null;
  }

  _resetRunState() {
    this._pollErrors.reset();
  }

  async start(fromBlock: unknown) {
    if (this._running) return;
    this._running = true;
    this._closed = false;
    this._resetRunState();

    try {
      const start = await initializeWatcherStart({
        fromBlock,
        registry: this._registry,
        checkpointKey: this._checkpointKey,
        getHeight: () => client.getHeight(),
        lookbackBlocks: WATCHER_LOOKBACK_BLOCKS,
        cacheKeys: this._cache.keys(),
        logger: watcherLogger,
      });
      this._lastBlock = start.startBlock;
      this._watchedAddresses = start.filter.addresses;
      this._watchedAddressSet = start.filter.addressSet;
    } catch (error) {
      this._running = false;
      watcherLogger.error({ error }, "Watcher initialization failed");
      throw error;
    }
    this._loopPromise = this._loop();
  }

  wait() {
    return this._loopPromise ?? Promise.resolve();
  }

  async addPools(newAddresses: unknown) {
    if (this._closed) return;

    const filter = updateWatcherAddressFilter(
      {
        addresses: this._watchedAddresses,
        addressSet: this._watchedAddressSet,
      },
      newAddresses,
    );
    if (!filter.shouldUpdate) return;
    this._watchedAddresses = filter.addresses;
    this._watchedAddressSet = filter.addressSet;

    if (filter.rejectedCount > 0) {
      watcherLogger.warn({ rejectedCount: filter.rejectedCount }, "Rejected invalid watcher pool addresses while updating filter");
    }
    if (filter.added.length > 0) {
      watcherLogger.info({ addedPools: filter.added.length }, "Adding new pools to watcher filter");
    }
  }

  async backfillPools(poolAddresses: unknown, options: { lookbackBlocks?: number; maxPools?: number } = {}) {
    if (this._closed || !this._running) return { logs: 0, changedPools: 0 };
    const input = Array.isArray(poolAddresses) || poolAddresses instanceof Set ? [...poolAddresses] : [poolAddresses];
    const maxPools = Math.max(0, Math.floor(Number(options.maxPools ?? HYPERSYNC_TARGETED_BACKFILL_MAX_POOLS) || 0));
    const addresses = input
      .map((addr) => (typeof addr === "string" ? addr.trim().toLowerCase() : ""))
      .filter((addr) => /^0x[0-9a-f]{40}$/.test(addr))
      .slice(0, maxPools);
    if (addresses.length === 0) return { logs: 0, changedPools: 0 };

    const lookbackBlocks = Math.max(0, Math.floor(Number(options.lookbackBlocks ?? HYPERSYNC_TARGETED_BACKFILL_LOOKBACK_BLOCKS) || 0));
    const fromBlock = Math.max(0, this._lastBlock - lookbackBlocks + 1);
    const response = await pollWatcherOnce({
      queries: buildWatcherLogQueries(addresses, fromBlock),
      getLogs: (query) => client.get<HyperSyncGetResponse<HyperSyncRawLog>>(query),
      isRunning: () => this._running,
      sleep: this._sleep.bind(this),
      logger: watcherLogger,
    });
    const logs = response?.data?.logs ?? [];
    if (logs.length === 0) return { logs: 0, changedPools: 0 };
    const changed = await this._handleLogs(logs);
    if (changed.size > 0) this.onBatch?.(changed);
    watcherLogger.info(
      { pools: addresses.length, logs: logs.length, changedPools: changed.size, fromBlock },
      "Targeted HyperSync pool backfill complete",
    );
    return { logs: logs.length, changedPools: changed.size };
  }

  async restart() {
    const resumeBlock = this._lastBlock;
    await this.stop();
    this._lastBlock = resumeBlock;
    this._running = true;
    this._closed = false;
    this._resetRunState();
    const loopPromise = this._loop();
    this._loopPromise = loopPromise;
  }

  async stop() {
    this._running = false;
    this._closed = true;
    this._wakeSleep();
    if (this._loopPromise) {
      await this._loopPromise.catch(() => {});
      this._loopPromise = null;
    }
    clearPendingWatcherEnrichment(this._pendingEnrichment);
  }

  get lastBlock() {
    return this._lastBlock;
  }

  get haltMeta() {
    return this._pollErrors.haltMeta;
  }

  _buildQueries() {
    return buildWatcherLogQueries(this._watchedAddresses, this._lastBlock + 1);
  }

  async _pollOnce(): Promise<WatcherPollResponse | null> {
    return pollWatcherOnce({
      queries: this._buildQueries(),
      getLogs: (query) => client.get<HyperSyncGetResponse<HyperSyncRawLog>>(query),
      isRunning: () => this._running,
      sleep: this._sleep.bind(this),
      logger: watcherLogger,
    });
  }

  _wakeSleep() {
    this._sleeper.wake();
  }

  async _sleep(ms: number) {
    await this._sleeper.sleep(ms, () => this._running);
  }

  async _waitForHeightAdvance(targetNextBlock: unknown, knownArchiveHeight: unknown) {
    await waitForWatcherHeightAdvance({
      targetNextBlock,
      knownArchiveHeight,
      sleep: this._sleep.bind(this),
      getHeight: () => client.getHeight(),
      isRunning: () => this._running,
      idleSleepMs: WATCHER_IDLE_SLEEP_MS,
    });
  }

  async _handleLogs(logs: HyperSyncRawLog[]) {
    return this._logHandler(logs);
  }

  async _loop() {
    watcherLogger.info(
      { fromBlock: this._lastBlock + 1, filterMode: watcherFilterMode(this._watchedAddresses.length) },
      "Starting manual HyperSync loop",
    );

    await runWatcherLoop({
      isRunning: () => this._running,
      stopForHalt: () => {
        this._running = false;
        this._closed = true;
      },
      getLastBlock: () => this._lastBlock,
      setLastBlock: (block) => {
        this._lastBlock = block;
      },
      pollOnce: this._pollOnce.bind(this),
      handlePollResponse: (response) =>
        handleWatcherPollResponse({
          response,
          registry: this._registry,
          checkpointKey: this._checkpointKey,
          currentLastBlock: this._lastBlock,
          idleSleepMs: WATCHER_IDLE_SLEEP_MS,
          handleLogs: this._handleLogs.bind(this),
          reloadCacheFromRegistry: this._stateAdapters.reloadCacheFromRegistry,
          advanceEnrichmentEpoch: this._stateAdapters.advanceEnrichmentEpoch,
          waitForHeightAdvance: this._waitForHeightAdvance.bind(this),
          sleep: this._sleep.bind(this),
          onBatch: this.onBatch,
          onReorg: this.onReorg,
          logger: watcherLogger,
        }),
      pollErrors: this._pollErrors,
      sleep: this._sleep.bind(this),
      wakeSleep: this._wakeSleep.bind(this),
      onHalt: (event) => this.onHalt?.(event),
      logger: watcherLogger,
    });
  }

  _enqueueEnrichment(addr: unknown, taskFn: EpochWatcherEnrichmentTask | WatcherEnrichmentTask) {
    return enqueueWatcherEnrichment({
      pending: this._pendingEnrichment,
      retryState: this._enrichmentRetryState,
      addr,
      taskFn,
      epoch: this._enrichmentEpoch,
      isClosed: () => this._closed,
      isCurrentEpoch: (epoch) => epoch === this._enrichmentEpoch,
      onCooldown: (meta) => {
        watcherLogger.debug(meta, "Watcher enrichment refresh in cooldown");
      },
      onRetry: (meta) => {
        watcherLogger.warn(meta, "Watcher enrichment refresh failed; entering cooldown");
      },
    });
  }
}
