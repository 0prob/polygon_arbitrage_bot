import type { RuntimeContext } from "../orchestrator/boot.ts";
import type { EventBus } from "../tui/events.ts";
import type { PoolMeta } from "../core/types/pool.ts";
import { fetchMissingPoolState } from "../pipeline/index.ts";
import { MAJOR_TOKENS } from "../core/constants.ts";

import {
  discoverPoolsFromHasura,
  fetchTokenMetasFromHasura,
  fetchTokenMetasForAddresses,
  loadStaticAnchors,
} from "../infra/hypersync/hyperindex_graphql.ts";
import { HasuraProgressSubscriber } from "../infra/hypersync/hasura_progress_subscriber.ts";
import { resolveInfraProfile } from "../config/infra_profile.ts";
import { debugBreak, DebugSites } from "../infra/debug/session.ts";

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
  private pools: PoolMeta[] = [];
  private tokenMetas: Map<string, { decimals: number }> | null = null;
  private lfStateRefreshCount = 0;

  private discoveryTimer: ReturnType<typeof setInterval> | null = null;
  private progressSubscriber: HasuraProgressSubscriber | null = null;

  private discoveryInProgress = false;
  private lfRefreshTask: Promise<void> | null = null;
  private expansionInProgress = false;
  private bootstrapInProgress = false;
  private discoveryDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Last indexer progress block that triggered an incremental pool discovery pass. */
  private lastProgressDiscoveryBlock = 0;
  /** Minimum blocks between progress-driven discovery triggers. */
  private static readonly PROGRESS_DISCOVERY_BLOCK_GAP = 32;
  private static readonly PRUNE_EVERY_LF_TICKS = 25;

  public get Pools(): PoolMeta[] {
    return this.pools;
  }

  public get TokenMetas(): Map<string, { decimals: number }> | null {
    return this.tokenMetas;
  }

  public get isBootstrapInProgress(): boolean {
    return this.bootstrapInProgress;
  }

  constructor(
    private ctx: RuntimeContext,
    private bus?: EventBus,
  ) {}

  async start(): Promise<void> {
    this.ctx.logger.info("StateRefreshService started");

    // Immediate first discovery on boot; LF refresh is owned by pass_loop runLfTick.
    this.runPoolDiscovery().catch((err) => { this.ctx.logger.warn?.({ err }, "Initial pool discovery failed"); });

    const graphqlUrl = this.ctx.config.hasuraUrl;
    if (graphqlUrl) {
      this.progressSubscriber = new HasuraProgressSubscriber({
        graphqlUrl,
        adminSecret: this.ctx.config.hasuraSecret ?? "",
        chainId: this.ctx.config.execution.chainId,
        logger: this.ctx.logger,
        execute: (fn) => this.ctx.hasuraCircuit.execute(fn),
      });
      this.progressSubscriber.setProgressHandler((progress) => {
        this.ctx.hyperIndexMonitor?.updateSyncedBlock(
          progress.lastProcessedBlock,
          progress.sourceBlock,
        );
        this.scheduleProgressDiscovery(progress.lastProcessedBlock);
      });
      void this.progressSubscriber.start().catch((err) => {
        this.ctx.logger.warn({ err }, "Hasura progress subscriber failed to start");
      });
    }

    // Dedicated discovery timer (default 60s)
    const discoveryInterval = this.ctx.config.discoveryIntervalMs ?? 60000;
    this.discoveryTimer = setInterval(() => {
      this.runPoolDiscovery().catch((err) => { this.ctx.logger.warn?.({ err }, "Periodic pool discovery failed"); });
    }, discoveryInterval);
  }

  /** Immediate discovery (e.g. mempool new-pool signal). */
  async triggerDiscovery(reason?: string): Promise<void> {
    this.ctx.logger.info({ reason }, "Triggering pool discovery");
    await this.runPoolDiscovery();
  }

  async stop(): Promise<void> {
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
    }
    if (this.discoveryDebounceTimer) {
      clearTimeout(this.discoveryDebounceTimer);
      this.discoveryDebounceTimer = null;
    }
    await this.progressSubscriber?.stop();
    this.progressSubscriber = null;
  }

  /** Debounced incremental discovery when HyperIndex syncs new blocks (faster than the 60s timer). */
  private scheduleProgressDiscovery(progressBlock: number): void {
    if (progressBlock <= this.lastProgressDiscoveryBlock) return;
    if (progressBlock - this.lastProgressDiscoveryBlock < StateRefreshService.PROGRESS_DISCOVERY_BLOCK_GAP) {
      return;
    }
    if (this.discoveryDebounceTimer) return;
    this.discoveryDebounceTimer = setTimeout(() => {
      this.discoveryDebounceTimer = null;
      this.lastProgressDiscoveryBlock = progressBlock;
      if (!this.discoveryInProgress) {
        this.runPoolDiscovery().catch((err) => {
          this.ctx.logger.debug?.({ err, progressBlock }, "Progress-driven pool discovery failed");
        });
      }
    }, 2000);
  }

  private liveCacheSize(): number {
    const cache = this.ctx.stateCache;
    return typeof cache.liveSize === "function" ? cache.liveSize() : cache.size;
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
        if (!this.tokenMetas) {
          const metas = await fetchTokenMetasFromHasura(graphqlUrl, secret, this.ctx.logger);
          if (metas.size > 0) {
            this.tokenMetas = metas;
          }
        } else if (result.pools.length > 0) {
          const tokenAddrs = [...new Set(result.pools.flatMap((p) => p.tokens))];
          const fresh = await fetchTokenMetasForAddresses(graphqlUrl, secret, tokenAddrs, this.ctx.logger);
          if (fresh.size > 0) {
            const merged = new Map(this.tokenMetas);
            for (const [addr, meta] of fresh) {
              merged.set(addr, meta);
            }
            this.tokenMetas = merged;
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
            debugBreak(DebugSites.STATE_DISCOVERY, {
              added: mapped.length,
              total: this.pools.length,
              maxBlock: result.maxBlock,
            });
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

        // Known pools are synced from pass_lf when the pool fingerprint changes.
    } catch (e) {
        this.ctx.logger.warn({ err: e }, "Failed to discover pools from Hasura");
        if (this.pools.length === 0) {
          try {
            const anchors = await loadStaticAnchors();
            if (anchors.length > 0) {
              this.pools = anchors;
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

  async runLfStateRefresh(): Promise<void> {
    if (this.lfRefreshTask) return this.lfRefreshTask;
    this.lfRefreshTask = this.runLfStateRefreshImpl().finally(() => {
      this.lfRefreshTask = null;
    });
    return this.lfRefreshTask;
  }

  private async runLfStateRefreshImpl(): Promise<void> {
    // Hot pool state comes from RPC (fetchMissingPoolState / head refresh).
    // Indexer progress is pushed via HasuraProgressSubscriber (GraphQL WS + HTTP fallback).
    this.lfStateRefreshCount++;

    if (this.lfStateRefreshCount % StateRefreshService.PRUNE_EVERY_LF_TICKS === 0) {
      const pruned = this.ctx.stateCache.prune?.() ?? 0;
      if (pruned > 0) {
        this.ctx.logger.debug?.({ pruned, liveSize: this.liveCacheSize() }, "Pruned expired pool state cache entries");
      }
    }

    const stateCacheEmpty = this.liveCacheSize() === 0;
    const infra = resolveInfraProfile(this.ctx.config);
    const lowInfra = infra.tier === "low";
    const stateClient = this.ctx.stateClient ?? this.ctx.publicClient;

    if (stateCacheEmpty && this.pools.length > 0 && !this.bootstrapInProgress) {
      this.bootstrapInProgress = true;
      this.runBootstrapInBackground(stateClient, lowInfra)
        .catch(err => this.ctx.logger.warn({err}, "Bootstrap failed"))
        .finally(() => { this.bootstrapInProgress = false; });
    }

    const CACHE_TARGET = 30000;
    const EXPANSION_CADENCE = lowInfra ? 20 : 10;
    if (!stateCacheEmpty && this.liveCacheSize() < CACHE_TARGET && this.lfStateRefreshCount % EXPANSION_CADENCE === 0 && !this.expansionInProgress) {
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
                { expanded: expanded.size, totalCached: this.liveCacheSize(), remaining: uncachedLen - expanded.size, lowInfra },
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
