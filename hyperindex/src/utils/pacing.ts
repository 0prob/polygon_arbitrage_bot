/**
 * Central pacing / quota awareness for the HyperIndex side.
 *
 * Primary goal: when running on free-tier HyperSync tokens (~200 rpm hard limit),
 * coordinate batch sizes, effect concurrency, and onBlock frequency so we stay
 * close to (but under) the limit without triggering long server backoffs.
 *
 * The single source of truth is HYPERSYNC_RPM_TARGET (falls back to 180 for safety
 * when the bot launches us, or 200 if someone runs `envio dev` directly).
 */

export function getRpmTarget(): number {
  const raw = process.env.HYPERSYNC_RPM_TARGET;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  // Safe default when running the indexer standalone
  return 180;
}

export function isLowQuota(): boolean {
  return getRpmTarget() < 150;
}

export function isVeryLowQuota(): boolean {
  return getRpmTarget() < 120;
}

/**
 * Recommended full_batch_size for config.yaml (or manual override).
 * Bigger batches amortize HyperSync roundtrips but create spikier request patterns.
 */
export function getRecommendedFullBatchSize(): number {
  const rpm = getRpmTarget();
  if (rpm >= 180) return 4500;
  if (rpm >= 150) return 2800;
  if (rpm >= 120) return 1800;
  return 1000;
}

/**
 * Max concurrent metadata effect calls (token + curve/balancer/dodo) per handler.
 * Raw Promise.all on a burst of PairCreated events is the easiest way to create
 * request spikes that interact badly with a tight HyperSync budget.
 */
export function getMetadataConcurrency(): number {
  const rpm = getRpmTarget();
  if (rpm >= 180) return 6;
  if (rpm >= 150) return 3;
  if (rpm >= 120) return 2;
  return 1;
}

/**
 * For onBlock handlers (currently only IndexerProgress).
 * On very tight quotas we can afford to be less chatty about progress.
 */
export function getProgressOnBlockStride(defaultStride: number): number {
  if (isVeryLowQuota()) return Math.max(defaultStride, 500);
  if (isLowQuota()) return Math.max(defaultStride, 300);
  return defaultStride;
}

/**
 * Run an array of async tasks with limited concurrency.
 * Used in factory handlers to avoid request spikes on bursts of PairCreated/PoolCreated
 * when HYPERSYNC_RPM_TARGET is low.
 */
export async function runWithConcurrency<T, R>(
  items: readonly T[] | T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (limit <= 1 || items.length <= 1) {
    return Promise.all(items.map((item, i) => fn(item, i)));
  }

  const results: R[] = new Array(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  });

  await Promise.all(workers);
  return results;
}
