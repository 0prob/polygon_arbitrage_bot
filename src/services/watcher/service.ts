import { Decoder, client as hypersyncClient } from "../../infra/hypersync/client.ts";
import type { HypersyncDecoderRuntime } from "../../infra/hypersync/types.ts";
import type { CompatDatabase } from "../../infra/db/connection.ts";
import { createRootLogger } from "../../infra/observability/logger.ts";
import type { ActivityLog } from "../../cli/activity.ts";
import type { RouteStateCache, WatcherPoolMeta, WatcherEnrichmentQueue, WatcherPoolRefresh, WatcherV3Refresh } from "./types.ts";
import { WatcherFilter } from "./filter.ts";
import { pollLoop } from "./poll_loop.ts";
import { WATCHER_SIGNATURES } from "./events.ts";

const logger = createRootLogger();

export interface WatcherRefreshFns {
  refreshBalancer?: WatcherPoolRefresh;
  refreshCurve?: WatcherPoolRefresh;
  refreshDodo?: WatcherPoolRefresh;
  refreshWoofi?: WatcherPoolRefresh;
  refreshV3?: WatcherV3Refresh;
}

export class WatcherService {
  private _filter: WatcherFilter;
  private _stateCache: RouteStateCache;
  private _db: CompatDatabase;
  private _running = false;
  private _loopPromise: Promise<void> | null = null;
  private _decoder: HypersyncDecoderRuntime;
  private _registry: {
    getRollbackGuard?: () => unknown;
    setRollbackGuard?: (guard: Record<string, unknown>) => unknown;
    getPoolMeta?: (addr: string) => WatcherPoolMeta | null | undefined;
  };
  private _refreshFns: Required<WatcherRefreshFns>;
  private _enrichmentQueue: Map<string, () => unknown> = new Map();
  private _enrichmentDrain: WatcherEnrichmentQueue = {
    enqueue: (addr, task) => {
      this._enrichmentQueue.set(addr.toLowerCase(), task);
      return undefined;
    },
    drain: () => {
      for (const task of this._enrichmentQueue.values()) {
        try {
          task();
        } catch (err) {
          logger.error({ err }, "Enrichment task failed");
        }
      }
      this._enrichmentQueue.clear();
    },
    size: () => this._enrichmentQueue.size,
  };

  onBatch: ((changed: Set<string>) => void) | null = null;
  onReorg: ((reorg: { reorgBlock: number; changedAddrs: Set<string> }) => void) | null = null;

  constructor(
    db: CompatDatabase,
    stateCache: RouteStateCache,
    registry: {
      getRollbackGuard?: () => unknown;
      setRollbackGuard?: (guard: Record<string, unknown>) => unknown;
      getPoolMeta?: (addr: string) => WatcherPoolMeta | null | undefined;
    } = {},
    refreshFns: WatcherRefreshFns = {},
    private _activity?: ActivityLog,
  ) {
    this._db = db;
    this._stateCache = stateCache;
    this._filter = new WatcherFilter();
    this._decoder = Decoder.fromSignatures(WATCHER_SIGNATURES as unknown as string[]);
    this._registry = registry;
    const noop = (_addr: string, _pool: WatcherPoolMeta | null) => {};
    const noopV3: WatcherV3Refresh = (_addr: string, _pool: WatcherPoolMeta | null, _rawLog?) => {};
    this._refreshFns = {
      refreshBalancer: refreshFns.refreshBalancer ?? noop,
      refreshCurve: refreshFns.refreshCurve ?? noop,
      refreshDodo: refreshFns.refreshDodo ?? noop,
      refreshWoofi: refreshFns.refreshWoofi ?? noop,
      refreshV3: refreshFns.refreshV3 ?? noopV3,
    };
  }

  start(pools?: string[]): void {
    if (this._running) return;
    this._running = true;
    if (pools && pools.length > 0) {
      this._filter.add(pools);
      this._activity?.("WATCHER", `Monitoring ${pools.length} pool addresses`);
    }
    this._loopPromise = this._run();
    logger.info({}, "Watcher service started");
  }

  async stop(): Promise<void> {
    this._running = false;
    if (this._loopPromise) {
      await this._loopPromise.catch(() => {});
      this._loopPromise = null;
    }
    logger.info({}, "Watcher service stopped");
  }

  getStateCache(): RouteStateCache {
    return this._stateCache;
  }

  private _run(): Promise<void> {
    return pollLoop(
      this._db,
      hypersyncClient,
      this._filter,
      this._stateCache,
      this._decoder,
      this._registry,
      this._enrichmentDrain,
      this._refreshFns.refreshBalancer,
      this._refreshFns.refreshCurve,
      this._refreshFns.refreshDodo,
      this._refreshFns.refreshWoofi,
      this._refreshFns.refreshV3,
      () => this._running,
      this.onBatch,
      this.onReorg,
    );
  }
}
