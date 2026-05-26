import type { AppConfig } from "../config/schema.ts";
import { createRootLogger, type Logger } from "../infra/observability/logger.ts";
import type { RouteStateCache } from "../core/types/route.ts";
import { Lifecycle } from "./lifecycle.ts";
import { PoolStateSubscriber } from "../services/mempool/subscriber.ts";
import { PublicClient } from "viem";

import { JITPoolDiscovery } from "../services/strategy/jit_discovery.ts";

export class BotSystem implements Lifecycle {
  private _logger: Logger;
  private _stateCache: RouteStateCache = new Map();
  private _subscriber: PoolStateSubscriber | null = null;
  private _jitDiscovery: JITPoolDiscovery | null = null;

  constructor(
    private _config: AppConfig,
    private _client: PublicClient,
  ) {
    this._logger = createRootLogger({ level: _config.observability.logLevel });
  }

  async prepare(): Promise<void> {
    this._logger.info("Preparing bot system");
    this._subscriber = new PoolStateSubscriber({
      client: this._client,
      onPoolUpdate: (addr, state) => {
        this._stateCache.set(addr.toLowerCase(), state);
      },
    });

    this._jitDiscovery = new JITPoolDiscovery(this._client, this._logger, {
      v2Factories: [
        "0x5757a6dc02559046ef819717757917208d27976e", // QuickSwap V2
        "0xc35dadb65012ec5796536bd9864ed447374dfb02", // SushiSwap V2
      ],
      v3Factories: [
        "0x1f98431c8ad98523631ae4a59f267346ea31f984", // Uniswap V3
        "0x411b0f56d09c2533ca9c08c407d5440c95094892", // QuickSwap V3
      ],
      onNewPool: (pool) => {
        // In a real implementation, we would also add this to the graph
        this._logger.info({ pool: pool.address }, "JIT Pool registered in system");
      }
    });
  }

  async start(): Promise<void> {
    this._logger.info("Starting bot system");
    if (this._jitDiscovery) await this._jitDiscovery.start();
  }

  async stop(): Promise<void> {
    this._logger.info("Stopping bot system");
  }

  get logger(): Logger {
    return this._logger;
  }
  get config(): AppConfig {
    return this._config;
  }
  get stateCache(): RouteStateCache {
    return this._stateCache;
  }
  get subscriber(): PoolStateSubscriber | null {
    return this._subscriber;
  }
}
