import { detectReorg } from "../state/reorg_detect.ts";
import type {
  RollbackGuard,
  WatcherRollbackResult,
} from "./watcher_poll_utils.ts";

export type WatcherRollbackRegistry = {
  getRollbackGuard?: () => unknown;
  rollbackWatcherState?: (
    checkpointKey: string,
    reorgBlock: number,
    rollbackGuard: RollbackGuard,
  ) => WatcherRollbackResult | null | undefined;
  rollbackToBlock?: (reorgBlock: number) => WatcherRollbackResult | null | undefined;
  setCheckpoint?: (key: string, block: number) => unknown;
  setRollbackGuard?: (rollbackGuard: RollbackGuard) => unknown;
};

export type WatcherRollbackGuardResult =
  | {
      reorgDetected: false;
    }
  | {
      reorgDetected: true;
      reorgBlock: number;
      checkpointBlock: number;
      rollbackResult: WatcherRollbackResult | null | undefined;
    };

export type HandleWatcherRollbackGuardOptions = {
  registry: WatcherRollbackRegistry;
  checkpointKey: string;
  rollbackGuard: RollbackGuard;
  beforeRollback?: (meta: { reorgBlock: number; checkpointBlock: number }) => void;
};

export function handleWatcherRollbackGuard({
  registry,
  checkpointKey,
  rollbackGuard,
  beforeRollback,
}: HandleWatcherRollbackGuardOptions): WatcherRollbackGuardResult {
  const reorgBlock = detectReorg(registry, rollbackGuard);
  if (reorgBlock === false) {
    registry.setRollbackGuard?.(rollbackGuard);
    return { reorgDetected: false };
  }

  const checkpointBlock = Math.max(0, reorgBlock - 1);
  beforeRollback?.({ reorgBlock, checkpointBlock });
  const rollbackResult = registry.rollbackWatcherState
    ? registry.rollbackWatcherState(checkpointKey, reorgBlock, rollbackGuard)
    : rollbackLegacyWatcherRegistry(registry, checkpointKey, reorgBlock, checkpointBlock, rollbackGuard);

  return {
    reorgDetected: true,
    reorgBlock,
    checkpointBlock,
    rollbackResult,
  };
}

function rollbackLegacyWatcherRegistry(
  registry: WatcherRollbackRegistry,
  checkpointKey: string,
  reorgBlock: number,
  checkpointBlock: number,
  rollbackGuard: RollbackGuard,
) {
  if (!registry.rollbackToBlock || !registry.setCheckpoint || !registry.setRollbackGuard) {
    throw new Error("Watcher registry does not support rollback operations.");
  }
  const rollbackResult = registry.rollbackToBlock(reorgBlock);
  registry.setCheckpoint(checkpointKey, checkpointBlock);
  registry.setRollbackGuard(rollbackGuard);
  return rollbackResult;
}
