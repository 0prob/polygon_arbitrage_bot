import type { HypersyncDecoderRuntime, HyperSyncGetResponse } from "../../infra/hypersync/types.ts";
import type { CompatDatabase } from "../../infra/db/connection.ts";
import { getCheckpoint, saveCheckpoint } from "../../infra/db/checkpoints.ts";
import { upsertPoolState } from "../../infra/db/pools.ts";
import { createRootLogger } from "../../infra/observability/logger.ts";
import type {
  DecodedWatcherLog,
  MutableWatcherState,
  WatcherPoolMeta,
  WatcherEnrichmentQueue,
  HyperSyncLogLike,
  RouteStateCache,
} from "./types.ts";
import { WatcherFilter } from "./filter.ts";
import { buildLogQuery as buildLogQueryOrig, commitWatcherStatesBatch } from "./state_ops.ts";
import { dispatchLog } from "./log_handler.ts";
import { checkReorg, type RollbackGuard } from "./reorg.ts";

const logger = createRootLogger();
const IDLE_SLEEP_MS = 1_000;
const WATCHER_CHECKPOINT_KEY = "HYPERSYNC_WATCHER";

function sortLogs(logs: HyperSyncLogLike[]): HyperSyncLogLike[] {
  return [...logs].sort((a, b) => {
    const ab = Number(a.blockNumber ?? 0);
    const bb = Number(b.blockNumber ?? 0);
    if (ab !== bb) return ab - bb;
    const at = Number(a.transactionIndex ?? 0);
    const bt = Number(b.transactionIndex ?? 0);
    if (at !== bt) return at - bt;
    return Number(a.logIndex ?? 0) - Number(b.logIndex ?? 0);
  });
}

function dedupeLogs(logs: HyperSyncLogLike[]): HyperSyncLogLike[] {
  const seen = new Set<string>();
  const result: HyperSyncLogLike[] = [];
  for (const log of sortLogs(logs)) {
    const txHash = typeof log.transactionHash === "string" ? log.transactionHash : "";
    const logIdx = String(log.logIndex ?? "");
    const key = `${txHash}:${logIdx}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(log);
  }
  return result;
}

export async function pollLoop(
  db: CompatDatabase,
  client: { get: <T>(query: unknown) => Promise<T> },
  filter: WatcherFilter,
  stateCache: RouteStateCache,
  decoder: HypersyncDecoderRuntime,
  registry: {
    getRollbackGuard?: () => unknown;
    setRollbackGuard?: (guard: RollbackGuard) => unknown;
    getPoolMeta?: (addr: string) => WatcherPoolMeta | null | undefined;
  },
  enrichmentQueue: WatcherEnrichmentQueue,
  refreshBalancer: (addr: string, pool: WatcherPoolMeta | null) => unknown,
  refreshCurve: (addr: string, pool: WatcherPoolMeta | null) => unknown,
  refreshDodo: (addr: string, pool: WatcherPoolMeta | null) => unknown,
  refreshWoofi: (addr: string, pool: WatcherPoolMeta | null) => unknown,
  refreshV3: (addr: string, pool: WatcherPoolMeta | null, rawLog?: HyperSyncLogLike) => unknown,
  signal: () => boolean,
  onBatch?: ((changed: Set<string>) => void) | null,
  onReorg?: ((reorg: { reorgBlock: number; changedAddrs: Set<string> }) => void) | null,
): Promise<void> {
  const checkpoint = getCheckpoint(db, WATCHER_CHECKPOINT_KEY);
  let lastBlock = checkpoint ? Number(checkpoint.block_number) : 0;

  while (signal()) {
    try {
      const initialFromBlock = lastBlock + 1;
      const chunks = filter.getChunks();
      let bestNextBlock = -1;
      let reorgTriggered = false;

      for (const chunk of chunks) {
        if (!signal()) return;
        if (reorgTriggered) break;

        const query = buildLogQueryOrig(initialFromBlock, chunk);
        const response = await client.get<HyperSyncGetResponse<HyperSyncLogLike>>(query);
        if (!signal()) return;

        const resp = response as { rollbackGuard?: RollbackGuard | null; data?: { logs?: HyperSyncLogLike[] }; nextBlock?: string };

        if (resp.rollbackGuard) {
          const reorgResult = checkReorg(db, registry, resp.rollbackGuard);
          if (reorgResult.reorgDetected) {
            const changedAddrs = new Set(stateCache.keys());
            stateCache.clear();
            logger.warn(
              { reorgBlock: reorgResult.reorgBlock, statesRemoved: reorgResult.statesRemoved, cacheCleared: changedAddrs.size },
              "Reorg detected; state cache cleared",
            );
            onReorg?.({ reorgBlock: reorgResult.reorgBlock, changedAddrs });
            lastBlock = reorgResult.checkpointBlock;
            reorgTriggered = true;
            break;
          }
          registry.setRollbackGuard?.(resp.rollbackGuard);
        }

        const logs = (resp.data?.logs ?? []) as unknown as HyperSyncLogLike[];

        if (logs.length === 0) {
          const nxt = Number(response.nextBlock);
          if (Number.isFinite(nxt) && nxt > bestNextBlock) bestNextBlock = nxt;
          continue;
        }

        const sorted = dedupeLogs(logs);
        const decoded = (await decoder.decodeLogs(sorted)) as unknown as DecodedWatcherLog[];
        const pendingUpdates: Array<{ addr: string; state: MutableWatcherState; rawLog: HyperSyncLogLike }> = [];
        const poolMetaCache = new Map<string, WatcherPoolMeta | null>();

        for (let i = 0; i < sorted.length; i++) {
          if (!signal()) return;
          const log = sorted[i];
          const dec = decoded[i];
          if (!dec) continue;
          const addrRaw = log.address;
          if (!addrRaw) continue;
          const addr = typeof addrRaw === "string" ? addrRaw.toLowerCase() : String(addrRaw).toLowerCase();
          if (!addr || addr.length !== 42) continue;

          let pool = poolMetaCache.get(addr);
          if (pool === undefined) {
            pool = registry.getPoolMeta?.(addr) ?? null;
            poolMetaCache.set(addr, pool);
          }
          if (!pool) continue;

          let state = stateCache.get(addr) as MutableWatcherState | undefined;
          if (!state) continue;
          state = { ...state } as MutableWatcherState;

          const applied = dispatchLog(log, dec as unknown as DecodedWatcherLog, pool, state, {
            addr,
            enqueueEnrichment: enrichmentQueue.enqueue,
            refreshBalancer,
            refreshCurve,
            refreshDodo,
            refreshWoofi,
            refreshV3,
          });
          if (applied) pendingUpdates.push({ addr, state, rawLog: log });
        }

        if (pendingUpdates.length > 0) {
          const persistStates = (states: Array<{ pool_address: string; block: number; data: MutableWatcherState }>) => {
            for (const s of states) upsertPoolState(db, s.pool_address, s.block, s.data);
          };
          const changed = commitWatcherStatesBatch(stateCache, persistStates, pendingUpdates);
          const changedSet = new Set(changed);
          if (changedSet.size > 0) onBatch?.(changedSet);
        }

        if (enrichmentQueue.size() > 0) {
          logger.debug({ queued: enrichmentQueue.size() }, "Draining enrichment queue");
          enrichmentQueue.drain();
        }

        const nxt = Number(response.nextBlock);
        if (Number.isFinite(nxt) && nxt > bestNextBlock) bestNextBlock = nxt;
      }

      if (!reorgTriggered && bestNextBlock > lastBlock) {
        lastBlock = bestNextBlock - 1;
        saveCheckpoint(db, WATCHER_CHECKPOINT_KEY, lastBlock, "");
      }
    } catch (err) {
      if (!signal()) return;
      logger.error({ err }, "Watcher poll loop error");
    }

    await sleep(IDLE_SLEEP_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
