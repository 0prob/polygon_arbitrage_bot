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
  loadStaticAnchors,
} from "../infra/hypersync/hyperindex_graphql.ts";
import { resolveInfraProfile } from "../config/infra_profile.ts";

function protocolBreakdown(pools: PoolMeta[]): Record<string, number> {
  return pools.reduce(
    (acc, p) => {
      const proto = p.protocol.split("_")[0] ?? p.protocol;
      acc[proto] = (acc[proto] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );
}

export class StateRefreshService {
  private lastDiscoveredBlock = 0;
  private lastSeenBlock = 0;
  private pools: PoolMeta[] = [];
  private tokenMetas: Map<string, { decimals: number }> | null = null;
  private lfStateRefreshCount = 0;

  private discoveryTimer: ReturnType<typeof setInterval> | null = null;

  private discoveryInProgress = false;
  private lfInProgress = false;
  private lfRefreshTask: Promise<void> | null = null;
  private expansionInProgress = false;
  private bootstrapInProgress = false;

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

    // Immediate first discovery on boot; LF refresh is owned by pass_loop runLfTick.
    this.runPoolDiscovery().catch((err) => { this.ctx.logger.warn?.({ err }, "Initial pool discovery failed"); });

    // Dedicated discovery timer (default 60s)
    const discoveryInterval = this.ctx.config.discoveryIntervalMs ?? 60000;
    this.discoveryTimer = setInterval(() => {
      this.runPoolDiscovery().catch((err) => { this.ctx.logger.warn?.({ err }, "Periodic pool discovery failed"); });
    }, discoveryInterval);
  }

  async stop(): Promise<void> {
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
    }
  }

  resetLastSeenBlock(block?: number): void {
    this.lastSeenBlock = block ?? 0;
  }

  private async runPoolDiscovery(): Promise<void> {
    if (this.discoveryInProgress) return;
    if (
      this.pools.length > 0 &&
      !this.ctx.tierManager.shouldDiscover()
    ) {
      return;
    }

    this.discoveryInProgress = true;
    this.bus?.emit({ type: "pipeline_stage", stage: "DISCOVERY" });
    const graphqlUrl = this.ctx.config.hasuraUrl;
    const secret = this.ctx.config.hasuraSecret;

    try {
        const result = await this.ctx.hasuraCircuit.execute(
        () =>
            discoverPoolsFromHasura(graphqlUrl, secret, this.ctx.logger, {
            lastDiscoveredBlock: this.lastDiscoveredBlock,
            }),
        async () => {
            this.ctx.logger.warn({}, "Hasura circuit open — using cached or static pools");
            if (this.pools.length === 0) {
              const anchors = await loadStaticAnchors();
              return { pools: anchors, maxBlock: 0 };
            }
            return { pools: [], maxBlock: this.lastDiscoveredBlock };
        },
        );

        // Only fetch token metas on first boot or when new pools are discovered.
        // Skipping the unconditional Hasura call saves ~100-500ms per discovery cycle
        // when the pool set hasn't changed.
        if (!this.tokenMetas || result.pools.length > 0) {
            const metas = !this.tokenMetas
                ? await fetchTokenMetasFromHasura(graphqlUrl, secret, this.ctx.logger)
                : await this.refreshTokenMetas(graphqlUrl, secret);
            if (!this.tokenMetas && metas) {
                this.tokenMetas = metas;
            }
        }
        
        if (result.pools.length > 0) {
            const mapped: PoolMeta[] = result.pools.map((p) => ({
                address: p.address as `0x${string}`,
                protocol: p.protocol,
                token0: (p.tokens[0] ?? "") as `0x${string}`,
                token1: (p.tokens[1] ?? "") as `0x${string}`,
                tokens: p.tokens as `0x${string}`[],
                fee: p.fee,
                poolId: p.poolId,
            }));

            if (this.lastDiscoveredBlock > 0 && this.pools.length > 0) {
                const seen = new Set(this.pools.map((p) => p.address.toLowerCase()));
                for (const p of mapped) {
                    if (!seen.has(p.address.toLowerCase())) {
                        this.pools.push(p);
                        seen.add(p.address.toLowerCase());
                    }
                }
            } else {
                this.pools.splice(0, this.pools.length, ...mapped);
            }
            this.lastDiscoveredBlock = result.maxBlock;
            this.ctx.logger.info(
              { added: mapped.length, total: this.pools.length, protocols: protocolBreakdown(this.pools) },
              "Pools discovered from HyperIndex",
            );
        } else if (this.pools.length === 0) {
            const anchors = await loadStaticAnchors();
            if (anchors.length > 0) {
              this.pools = anchors;
              this.ctx.logger.info(
                { count: anchors.length, protocols: protocolBreakdown(anchors) },
                "Loaded static anchor pools (Hasura returned no pools on first discovery)",
              );
            }
        }

        if (this.pools.length > 0) {
          this.ctx.mempoolService.setKnownPools(this.pools.map((p) => p.address));
        }
    } catch (e) {
        this.ctx.logger.warn({ err: e }, "Failed to discover pools from Hasura");
        if (this.pools.length === 0) {
          try {
            const anchors = await loadStaticAnchors();
            if (anchors.length > 0) {
              this.pools = anchors;
              this.ctx.mempoolService.setKnownPools(this.pools.map((p) => p.address));
              this.ctx.logger.info(
                { count: anchors.length, protocols: protocolBreakdown(anchors) },
                "Loaded static anchor pools after discovery failure",
              );
            }
          } catch (anchorErr) {
            this.ctx.logger.debug?.({ err: anchorErr }, "Static anchor fallback failed");
          }
        }
    } finally {
        this.discoveryInProgress = false;
    }
  }

  private async refreshTokenMetas(graphqlUrl: string, secret: string): Promise<Map<string, { decimals: number }> | null> {
    try {
      const fresh = await fetchTokenMetasFromHasura(graphqlUrl, secret, this.ctx.logger);
      if (fresh.size > 0 && this.tokenMetas) {
        const merged = new Map(this.tokenMetas);
        for (const [addr, meta] of fresh) {
          merged.set(addr, meta);
        }
        this.tokenMetas = merged;
      } else if (fresh.size > 0) {
        this.tokenMetas = fresh;
      }
      return this.tokenMetas;
    } catch (err) {
      this.ctx.logger.debug?.({ err }, "Token meta refresh failed");
      return this.tokenMetas;
    }
  }

  async runLfStateRefresh(): Promise<void> {
    if (this.lfRefreshTask) return this.lfRefreshTask;
    this.lfRefreshTask = this.runLfStateRefreshImpl().finally(() => {
      this.lfInProgress = false;
      this.lfRefreshTask = null;
    });
    return this.lfRefreshTask;
  }

  private async runLfStateRefreshImpl(): Promise<void> {
    this.lfInProgress = true;
    const graphqlUrl = this.ctx.config.hasuraUrl;
      const secret = this.ctx.config.hasuraSecret;

      try {
        const [{ stateCache, maxSeenBlock }, fetchedProgress] = await Promise.all([
          this.ctx.hasuraCircuit.execute(() => buildStateCacheFromGraphQL(graphqlUrl, secret, this.ctx.logger, { lastSeenBlock: this.lastSeenBlock })),
          this.ctx.hasuraCircuit.execute(() => fetchIndexerProgressFromHasura(graphqlUrl, secret, this.ctx.logger))
        ]);

        let newEntries = 0;
        let skippedStale = 0;
        let updatedEntries = 0;
        const now = Date.now();
        for (const [addr, state] of stateCache.entries()) {
          const alreadyCached = this.ctx.stateCache.has(addr, now);
          const s = state as Record<string, unknown>;
          const liq = typeof s.liquidity === "bigint" ? (s.liquidity as bigint) : null;
          const r0 = typeof s.reserve0 === "bigint" ? (s.reserve0 as bigint) : null;
          const r1 = typeof s.reserve1 === "bigint" ? (s.reserve1 as bigint) : null;
          const staleV3 = liq !== null && liq === 0n;
          const staleV2 = r0 !== null && r1 !== null && r0 === 0n && r1 === 0n;
          if (staleV3 || staleV2) {
            skippedStale++;
          } else {
            if (alreadyCached) updatedEntries++;
            else newEntries++;
            this.ctx.stateCache.set(addr, state, now);
          }
        }
        if (maxSeenBlock > this.lastSeenBlock) {
          this.lastSeenBlock = maxSeenBlock;
        }
        this.ctx.logger.debug({ entries: stateCache.size, newEntries, updatedEntries, skippedStale, lastSeenBlock: this.lastSeenBlock }, "State and TokenMeta refreshed from HyperIndex");

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
      const infra = resolveInfraProfile(this.ctx.config);
      const lowInfra = infra.tier === "low";
      const stateClient = this.ctx.stateClient ?? this.ctx.publicClient;

      if (stateCacheEmpty && this.pools.length > 0 && !this.bootstrapInProgress) {
        this.bootstrapInProgress = true;
        this.runBootstrapInBackground(stateClient, lowInfra)
          .catch(err => this.ctx.logger.warn({err}, "Bootstrap failed"))
          .finally(() => { this.bootstrapInProgress = false; });
      }

      this.lfStateRefreshCount++;
      const CACHE_TARGET = 30000;
      const EXPANSION_CADENCE = lowInfra ? 20 : 10;
      if (!stateCacheEmpty && this.ctx.stateCache.size < CACHE_TARGET && this.lfStateRefreshCount % EXPANSION_CADENCE === 0 && !this.expansionInProgress) {
        const BASE_EXP = 6000;
        const EXPANSION_BATCH = lowInfra ? 1000 : BASE_EXP;
        const uncached = this.pools.filter((p) => !this.ctx.stateCache.has(p.address.toLowerCase()));
        if (uncached.length > 0) {
          const batch = uncached.slice(0, EXPANSION_BATCH);
          const uncachedLen = uncached.length;
          this.expansionInProgress = true;
          fetchMissingPoolState(stateClient, this.ctx.stateCache, batch, [], [], true)
            .then((expanded) => {
              if (expanded.size > 0) {
                this.ctx.logger.info(
                  { expanded: expanded.size, totalCached: this.ctx.stateCache.size, remaining: uncachedLen - expanded.size, lowInfra },
                  "Gradual cache expansion batch complete (background)",
                );
              }
            })
            .catch((err) => this.ctx.logger.warn({ err }, "Background gradual expansion failed"))
            .finally(() => { this.expansionInProgress = false; });
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
