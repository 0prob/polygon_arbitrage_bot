import type { Address } from "../../core/types/common.ts";
import type { Logger } from "../../infra/observability/logger.ts";
import type { DecodedPoolEvent } from "./decoder.ts";
import type { TokenMetaFetcher } from "./enrichment.ts";
import type { CurveFactoryFetcher } from "./curve_factory.ts";

export interface DiscoveryResult {
  discovered: number;
  pools: Array<{ address: Address; protocol: string; tokens: Address[] }>;
}

export interface DiscoveryServiceDeps {
  logger: Logger;
  decodeLog: (logs: unknown[]) => DecodedPoolEvent[];
  fetchTokenMeta: TokenMetaFetcher;
  fetchCurvePools: CurveFactoryFetcher;
  savePool: (pool: { address: Address; protocol: string; tokens: Address[] }) => Promise<void>;
}

export class DiscoveryService {
  constructor(private deps: DiscoveryServiceDeps) {}

  async start(): Promise<void> {
    this.deps.logger.info({}, "DiscoveryService started");
  }

  stop(): void {
    this.deps.logger.info({}, "DiscoveryService stopped");
  }

  async discoverProtocol(_protocol: string): Promise<DecodedPoolEvent[]> {
    return [];
  }
}
