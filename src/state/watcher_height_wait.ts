import { HYPERSYNC_WATCHER_IDLE_SLEEP_MS } from "../config/index.ts";

export const WATCHER_IDLE_SLEEP_MS = HYPERSYNC_WATCHER_IDLE_SLEEP_MS;

/**
 * Adaptive sleep calculation based on poll lag.
 * Reduces idle time when behind, increases when caught up.
 */
export function calculateAdaptiveSleepMs(
  pollLagBlocks: number | null | undefined,
  baseSleepMs: number,
): number {
  if (pollLagBlocks == null || pollLagBlocks <= 0) {
    // Caught up - use base sleep
    return baseSleepMs;
  }
  
  // Behind on blocks - aggressive polling but with rate limiting.
  // Don't poll faster than 200ms to avoid hammering HyperSync with
  // thousands of requests per second after a restart or extended downtime.
  if (pollLagBlocks >= 10) {
    return Math.max(200, Math.floor(baseSleepMs * 0.05));
  }
  
  // Moderate lag
  if (pollLagBlocks >= 3) {
    return Math.max(100, Math.floor(baseSleepMs * 0.3)); // 100ms min
  }
  
  // Slight lag
  if (pollLagBlocks >= 1) {
    return Math.max(200, Math.floor(baseSleepMs * 0.5)); // 200ms min
  }
  
  return baseSleepMs;
}

export type WaitForWatcherHeightAdvanceOptions = {
  targetNextBlock: unknown;
  knownArchiveHeight: unknown;
  sleep: (ms: number) => Promise<void>;
  getHeight: () => Promise<unknown>;
  isRunning: () => boolean;
  idleSleepMs?: number;
  pollLagBlocks?: number | null;
};

export async function waitForWatcherHeightAdvance({
  targetNextBlock,
  knownArchiveHeight,
  sleep,
  getHeight,
  isRunning,
  idleSleepMs = WATCHER_IDLE_SLEEP_MS,
  pollLagBlocks,
}: WaitForWatcherHeightAdvanceOptions) {
  const numericTargetNextBlock = Number(targetNextBlock);
  let currentHeight = Number(knownArchiveHeight);

  if (
    !Number.isFinite(numericTargetNextBlock) ||
    !Number.isFinite(currentHeight) ||
    currentHeight >= numericTargetNextBlock
  ) {
    const adaptiveSleep = calculateAdaptiveSleepMs(pollLagBlocks ?? null, idleSleepMs);
    await sleep(adaptiveSleep);
    return;
  }

  while (isRunning() && currentHeight < numericTargetNextBlock) {
    const adaptiveSleep = calculateAdaptiveSleepMs(pollLagBlocks ?? null, idleSleepMs);
    await sleep(adaptiveSleep);
    if (!isRunning()) break;

    try {
      const nextHeight = Number(await getHeight());
      if (!Number.isFinite(nextHeight)) {
        break;
      }
      currentHeight = nextHeight;
    } catch {
      break;
    }
  }
}
