import type { Logger } from "../../infra/observability/logger.ts";
import type { PoolMeta } from "../../core/types/pool.ts";
import type { Address } from "../../core/types/common.ts";

export type StateCache = Map<string, Record<string, unknown>>;
export type PoolStateFetcher = (address: Address, protocol: string, token0: Address, token1: Address) => Promise<Record<string, unknown> | null>;

export class HydrationService {
  private running = false;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private logger: Logger,
    private stateCache: StateCache,
    private fetchPoolState: PoolStateFetcher,
    private pools: () => PoolMeta[],
  ) {}

  async start(): Promise<void> {
    this.running = true;
    this.logger.info({}, "HydrationService started");
  }

  stop(): void {
    this.running = false;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.logger.info({}, "HydrationService stopped");
  }

  async warmup(hubTokens: readonly Address[]): Promise<number> {
    const { warmupStateCache } = await import("./warmup.ts");
    const pools = this.pools();
    const hubs = hubTokens.map((t) => t.toLowerCase());
    const hubSet = new Set(hubs);
    const hubPools = pools.filter((p) => (p.tokens ?? []).some((t) => hubSet.has(t.toLowerCase())));
    const result = await warmupStateCache(hubPools, hubTokens, this.fetchPoolState);
    for (const [addr, state] of result) this.stateCache.set(addr, state);
    this.logger.info({ hydrated: result.size }, "Warmup complete");
    return result.size;
  }

  private _sweepPromise: Promise<void> | null = null;

  startSweep(intervalMs = 60_000): void {
    this.sweepTimer = setInterval(async () => {
      if (!this.running || this._sweepPromise) return;
      this._sweepPromise = (async () => {
        try {
          const { sweepQuietPools } = await import("./sweep.ts");
          const hydrated = await sweepQuietPools(this.pools(), this.stateCache, this.fetchPoolState);
          if (hydrated > 0) this.logger.info({ hydrated }, "Quiet pool sweep");
        } catch (err) {
          this.logger.error({ err }, "Sweep error");
        } finally {
          this._sweepPromise = null;
        }
      })();
    }, intervalMs);
  }
}
