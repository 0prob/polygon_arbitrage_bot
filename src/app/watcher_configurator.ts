import { configureWatcherCallbacks } from "./lifecycle.ts";
import type {
  PoolsChangedEvent,
  ReorgDetectedEvent,
  WatcherHaltEvent,
} from "./runner.ts";

type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";
type LoggerFn = (msg: string, level?: LogLevel, meta?: unknown) => void;
type WatcherLike = Parameters<typeof configureWatcherCallbacks>[0]["watcher"];

type WatcherConfiguratorDeps = {
  log: LoggerFn;
  handlePoolsChanged: (changedPools: PoolsChangedEvent["changedPools"]) => Promise<void> | void;
  handleReorgDetected: (
    reorgBlock: ReorgDetectedEvent["reorgBlock"],
    changedPools: ReorgDetectedEvent["changedPools"],
  ) => void;
  handleHaltDetected: (payload: WatcherHaltEvent["payload"]) => void;
  scheduleArb: (changedPools?: number) => void;
};

export function createWatcherConfigurator({
  log,
  handlePoolsChanged,
  handleReorgDetected,
  handleHaltDetected,
  scheduleArb,
}: WatcherConfiguratorDeps) {
  return function configureWatcher(watcher: WatcherLike) {
    configureWatcherCallbacks({
      watcher,
      log,
      onPoolsChanged: async ({ changedPools }) => {
        await handlePoolsChanged(changedPools);
      },
      onReorgDetected: ({ reorgBlock, changedPools }) => {
        handleReorgDetected(reorgBlock, changedPools);
      },
      onHaltDetected: ({ payload }) => {
        handleHaltDetected(payload);
      },
      scheduleArb,
    });
  };
}
