import { Decoder, client as hypersyncClient } from "../../infra/hypersync/client.ts";
import type { HypersyncDecoderRuntime } from "../../infra/hypersync/types.ts";
import type { CompatDatabase } from "../../infra/db/connection.ts";
import { createRootLogger } from "../../infra/observability/logger.ts";
import type { RouteStateCache, WatcherPoolMeta, WatcherEnrichmentQueue } from "./types.ts";
import { WatcherFilter } from "./filter.ts";
import { pollLoop } from "./poll_loop.ts";
import { WATCHER_SIGNATURES } from "./events.ts";

const logger = createRootLogger();

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
  ) {
    this._db = db;
    this._stateCache = stateCache;
    this._filter = new WatcherFilter();
    this._decoder = Decoder.fromSignatures(WATCHER_SIGNATURES);
    this._registry = registry;
  }

  start(pools?: string[]): void {
    if (this._running) return;
    this._running = true;
    if (pools && pools.length > 0) this._filter.add(pools);
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

  private noopRefresh = (_addr: string, _pool: WatcherPoolMeta | null) => {};

  private _run(): Promise<void> {
    return pollLoop(
      this._db,
      hypersyncClient,
      this._filter,
      this._stateCache,
      this._decoder,
      this._registry,
      this._enrichmentDrain,
      this.noopRefresh,
      this.noopRefresh,
      this.noopRefresh,
      this.noopRefresh,
      this.noopRefresh,
      () => this._running,
      this.onBatch,
      this.onReorg,
    );
  }
}
