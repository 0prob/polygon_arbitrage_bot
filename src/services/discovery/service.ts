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

  async discoverProtocol(protocol: string): Promise<DecodedPoolEvent[]> {
    this.deps.logger.info({ protocol }, "Discovering protocol");
    let pools: Array<{ address: Address; protocol: string; tokens: Address[] }> = [];

    if (protocol === "curve") {
      const curvePools = await this.deps.fetchCurvePools("0x296d2B5C23833A70D07c8fCBB97d846c1ff90DDD"); // Curve Meta Registry on Polygon
      pools = curvePools.map(p => ({ address: p.poolAddress, protocol: "curve", tokens: p.coins }));
    } else if (protocol === "balancer") {
      // Placeholder for balancer discovery
      this.deps.logger.warn({ protocol }, "Balancer discovery not yet implemented");
    }

    for (const pool of pools) {
      await this.deps.savePool(pool);
    }

    this.deps.logger.info({ protocol, discovered: pools.length }, "Finished discovering protocol");
    return []; // Return empty for now, as DecodedPoolEvent is more complex
  }
}
