import type { AppConfig } from "../config/schema.ts";
import { createRootLogger, type Logger } from "../infra/observability/logger.ts";
import type { RouteStateCache } from "../core/types/route.ts";
import { Lifecycle } from "./lifecycle.ts";
import { PoolStateSubscriber } from "../services/mempool/subscriber.ts";
import { PublicClient } from "viem";

export class BotSystem implements Lifecycle {
  private _logger: Logger;
  private _stateCache: RouteStateCache = new Map();
  private _subscriber: PoolStateSubscriber | null = null;

  constructor(private _config: AppConfig, private _client: PublicClient) {
    this._logger = createRootLogger({ level: _config.observability.logLevel });
  }

  async prepare(): Promise<void> {
    this._logger.info("Preparing bot system");
    this._subscriber = new PoolStateSubscriber({
        client: this._client,
        onPoolUpdate: (addr, state) => {
            this._stateCache.set(addr.toLowerCase(), state);
        }
    });
  }

  async start(): Promise<void> {
    this._logger.info("Starting bot system");
  }

  async stop(): Promise<void> {
    this._logger.info("Stopping bot system");
  }

  get logger(): Logger { return this._logger; }
  get config(): AppConfig { return this._config; }
  get stateCache(): RouteStateCache { return this._stateCache; }
  get subscriber(): PoolStateSubscriber | null { return this._subscriber; }
}
