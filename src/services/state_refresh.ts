import type { RuntimeContext } from "../orchestrator/boot.ts";
import type { EventBus } from "../tui/events.ts";
import type { PoolMeta } from "../core/types/pool.ts";
import { fetchMissingPoolState } from "../pipeline/index.ts";
import { MAJOR_TOKENS } from "../core/constants.ts";

import {
  discoverPoolsFromHasura,
  buildStateCacheFromGraphQL,
  fetchIndexerProgressFromHasura,
  fetchTokenMetasFromHasura,
} from "../infra/hypersync/hyperindex_graphql.ts";

export class StateRefreshService {
  private lastDiscoveryTime = 0;
  private lastDiscoveredBlock = 0;
  private pools: PoolMeta[] = [];
  private tokenMetas: Map<string, { decimals: number }> | null = null;
  private lfStateRefreshCount = 0;

  public get Pools(): PoolMeta[] {
    return this.pools;
  }

  public get TokenMetas(): Map<string, { decimals: number }> | null {
    return this.tokenMetas;
  }

  constructor(
    private ctx: RuntimeContext,
    private bus?: EventBus,
  ) {}

  async start(): Promise<void> {
    this.ctx.logger.info("StateRefreshService started");
    this.runLoop();
  }

  private async runLoop(): Promise<void> {
    while (this.ctx.isRunning) {
      try {
        await this.runPoolDiscovery();
        await this.runLfStateRefresh();
        
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (err) {
        this.ctx.logger.error({ err }, "Error in StateRefreshService");
      }
    }
  }

  private async runPoolDiscovery(): Promise<void> {
    const DISCOVERY_INTERVAL = 60000;
    const now = Date.now();
    if (
        !(
          this.pools === null ||
          this.pools.length === 0 ||
          (now - this.lastDiscoveryTime > DISCOVERY_INTERVAL && this.ctx.tierManager.shouldDiscover())
        )
      ) {
        return;
      }

    this.bus?.emit({ type: "pipeline_stage", stage: "DISCOVERY" });
    const graphqlUrl = this.ctx.config.hasuraUrl;
    const secret = this.ctx.config.hasuraSecret;

    try {
        const [result, metas] = await Promise.all([
            this.ctx.rpcCircuit.execute(
            () =>
                discoverPoolsFromHasura(graphqlUrl, secret, this.ctx.logger, {
                lastDiscoveredBlock: this.lastDiscoveredBlock,
                }),
            async () => {
                this.ctx.logger.warn({}, "Hasura circuit open, returning empty pool list");
                return { pools: [], maxBlock: this.lastDiscoveredBlock };
            },
            ),
            !this.tokenMetas ? fetchTokenMetasFromHasura(graphqlUrl, secret, this.ctx.logger) : Promise.resolve(this.tokenMetas)
        ]);

        if (!this.tokenMetas && metas) {
            this.tokenMetas = metas;
        }
        
        if (result.pools.length > 0) {
            const mapped: PoolMeta[] = result.pools.map((p) => ({
                address: p.address as `0x${string}`,
                protocol: p.protocol,
                token0: (p.tokens[0] ?? "") as `0x${string}`,
                token1: (p.tokens[1] ?? "") as `0x${string}`,
                tokens: p.tokens as `0x${string}`[],
                fee: p.fee,
            }));

            if (this.lastDiscoveredBlock > 0 && this.pools) {
                const seen = new Set(this.pools.map((p) => p.address.toLowerCase()));
                for (const p of mapped) {
                    if (!seen.has(p.address.toLowerCase())) {
                        this.pools.push(p);
                        seen.add(p.address.toLowerCase());
                    }
                }
            } else {
                this.pools = mapped;
            }
            this.lastDiscoveryTime = now;
            this.lastDiscoveredBlock = result.maxBlock;
        }
    } catch (e) {
        this.ctx.logger.warn({ err: e }, "Failed to discover pools from Hasura");
    }
  }

  private async runLfStateRefresh(): Promise<void> {
    const graphqlUrl = this.ctx.config.hasuraUrl;
    const secret = this.ctx.config.hasuraSecret;

    try {
      const [gqlCache, fetchedProgress] = await Promise.all([
        this.ctx.hasuraCircuit.execute(() => buildStateCacheFromGraphQL(graphqlUrl, secret, this.ctx.logger)),
        this.ctx.hasuraCircuit.execute(() => fetchIndexerProgressFromHasura(graphqlUrl, secret, this.ctx.logger))
      ]);

      let newEntries = 0;
      let skippedStale = 0;
      for (const [addr, state] of gqlCache.entries()) {
        if (!this.ctx.stateCache.has(addr)) {
          const s = state as Record<string, unknown>;
          const liq = typeof s.liquidity === "bigint" ? (s.liquidity as bigint) : null;
          const r0 = typeof s.reserve0 === "bigint" ? (s.reserve0 as bigint) : null;
          const r1 = typeof s.reserve1 === "bigint" ? (s.reserve1 as bigint) : null;
          const staleV3 = liq !== null && liq === 0n;
          const staleV2 = r0 !== null && r1 !== null && r0 === 0n && r1 === 0n;
          if (staleV3 || staleV2) {
            skippedStale++;
            continue;
          }
          this.ctx.stateCache.set(addr, state);
          newEntries++;
        }
      }
      this.ctx.logger.debug({ entries: gqlCache.size, newEntries, skippedStale }, "State and TokenMeta refreshed from HyperIndex");

      if (fetchedProgress && this.ctx.hyperIndexMonitor) {
        this.ctx.hyperIndexMonitor.updateSyncedBlock(fetchedProgress.lastProcessedBlock);
      }
    } catch (err) {
      const isCircuitOpenError = err instanceof Error && err.message.includes("Circuit breaker") && err.message.includes("is open");
      if (isCircuitOpenError && this.ctx.hasuraCircuit.getState() === "open") {
        this.ctx.logger.debug({ err }, "Hasura circuit open — skipping HyperIndex state refresh");
      } else {
        this.ctx.logger.warn({ err }, "Failed to refresh state from HyperIndex");
      }
    }

    const stateCacheEmpty = this.ctx.stateCache.size === 0;
    const rps = this.ctx.config.rpc.chainstackRps ?? 250;
    const lowInfra = rps <= 250;
    const stateClient = this.ctx.stateClient ?? this.ctx.publicClient;

    if (stateCacheEmpty && this.pools.length > 0) {
      this.runBootstrapInBackground(stateClient, lowInfra).catch(err => this.ctx.logger.warn({err}, "Bootstrap failed"));
    }

    this.lfStateRefreshCount++;
    const CACHE_TARGET = 30000;
    const EXPANSION_CADENCE = lowInfra ? 20 : 10;
    if (!stateCacheEmpty && this.ctx.stateCache.size < CACHE_TARGET && this.lfStateRefreshCount % EXPANSION_CADENCE === 0) {
      const BASE_EXP = 6000;
      const EXPANSION_BATCH = lowInfra ? 1000 : BASE_EXP;
      const uncached = this.pools.filter((p) => !this.ctx.stateCache.has(p.address.toLowerCase()));
      if (uncached.length > 0) {
        const batch = uncached.slice(0, EXPANSION_BATCH);
        const uncachedLen = uncached.length;
        fetchMissingPoolState(stateClient, this.ctx.stateCache, batch, [], [], true)
          .then((expanded) => {
            if (expanded.size > 0) {
              this.ctx.logger.info(
                { expanded: expanded.size, totalCached: this.ctx.stateCache.size, remaining: uncachedLen - expanded.size, lowInfra },
                "Gradual cache expansion batch complete (background)",
              );
            }
          })
          .catch((err) => this.ctx.logger.warn({ err }, "Background gradual expansion failed"));
      }
    }
  }

  private async runBootstrapInBackground(stateClient: import("viem").PublicClient, lowInfra: boolean): Promise<void> {
    const MAX_BOOTSTRAP_POOLS = lowInfra ? 5000 : 12000;
    const stateAddrSet = new Set<string>();
    for (const addr of this.ctx.stateCache.keys()) stateAddrSet.add(addr);
    const missingPools = this.pools.filter((p) => !stateAddrSet.has(p.address.toLowerCase()));

    const touchesMajor = (p: PoolMeta) => {
      const ts = (p.tokens ?? [p.token0, p.token1]).map((t) => t.toLowerCase());
      return ts.some((t) => MAJOR_TOKENS.has(t));
    };

    const prioritized = [...missingPools].sort((a, b) => (touchesMajor(b) ? 1 : 0) - (touchesMajor(a) ? 1 : 0));
    const toBootstrap = prioritized.slice(0, MAX_BOOTSTRAP_POOLS);

    if (toBootstrap.length === 0) return;

    const BATCH_SIZE_BS = lowInfra ? 2000 : 5000;
    const CONCURRENCY_BS = lowInfra ? 3 : 6;
    const batches: PoolMeta[][] = [];
    for (let i = 0; i < toBootstrap.length; i += BATCH_SIZE_BS) {
      batches.push(toBootstrap.slice(i, i + BATCH_SIZE_BS));
    }
    const localUpdated = new Set<string>();
    for (let i = 0; i < batches.length; i += CONCURRENCY_BS) {
      const chunk = batches.slice(i, i + CONCURRENCY_BS);
      const results = await Promise.all(chunk.map((batch) => fetchMissingPoolState(stateClient, this.ctx.stateCache, batch, [], [], true)));
      for (const res of results) {
        for (const addr of res) localUpdated.add(addr);
      }
    }
    this.ctx.logger.info(
      { seedFetched: localUpdated.size, stillMissing: toBootstrap.length - localUpdated.size, lowInfra },
      "Background bootstrap fetch complete",
    );
  }
}
