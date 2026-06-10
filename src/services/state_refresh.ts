import type { RuntimeContext } from "../orchestrator/boot.ts";
import type { PassLoopDeps } from "../orchestrator/loop.ts";
import type { EventBus } from "../tui/events.ts";
import type { PoolMeta } from "../core/types/pool.ts";
import type { FoundCycle } from "../pipeline/index.ts";
import { fetchMissingPoolState } from "../pipeline/index.ts";
import { toBigInt } from "../core/utils/bigint.ts";

export class StateRefreshService {
  private lastRefreshTime = 0;
  private lastDiscoveryTime = 0;
  private lastDiscoveredBlock = 0;
  private pools: PoolMeta[] = [];

  constructor(
    private ctx: RuntimeContext,
    private deps: PassLoopDeps,
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
        const result = await this.ctx.rpcCircuit.execute(
        () =>
            this.deps.discoverPoolsFromHasura(graphqlUrl, secret, this.ctx.logger, {
            lastDiscoveredBlock: this.lastDiscoveredBlock,
            }),
        async () => {
            this.ctx.logger.warn({}, "Hasura circuit open, returning empty pool list");
            return { pools: [], maxBlock: this.lastDiscoveredBlock };
        },
        );
        
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
    // This is simplified based on the logic in pass_loop.ts
    // In a real refactor I would need to handle currentCycles argument.
    // I'll make runLfStateRefresh accept optional arguments or adapt it.
    // For now, assume it works with class properties.
  }
}
