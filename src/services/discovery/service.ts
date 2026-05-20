import type { Address } from "../../core/types/common.ts";
import type { Logger } from "../../infra/observability/logger.ts";
import type { ActivityLog } from "../../cli/activity.ts";
import type { DecodedPoolEvent } from "./decoder.ts";
import type { TokenMetaFetcher } from "./enrichment.ts";
import type { CurveFactoryFetcher } from "./curve_factory.ts";
import type { V2PoolInfo } from "./v2_discovery.ts";
import type { V3PoolInfo } from "./v3_discovery.ts";

export interface DiscoveryResult {
  discovered: number;
  pools: Array<{ address: Address; protocol: string; tokens: Address[] }>;
}

export interface V2FactoryConfig {
  address: Address;
  label: string;
}

export interface DiscoveryServiceDeps {
  logger: Logger;
  activity: ActivityLog;
  decodeLog: (logs: unknown[]) => DecodedPoolEvent[];
  fetchTokenMeta: TokenMetaFetcher;
  fetchCurvePools: CurveFactoryFetcher;
  fetchV2Pools: (factoryAddress: Address, protocolLabel: string) => Promise<V2PoolInfo[]>;
  discoverV3Pools: (factoryAddresses: Address[]) => Promise<V3PoolInfo[]>;
  savePool: (pool: { address: Address; protocol: string; tokens: Address[] }) => Promise<void>;
  v2Factories: V2FactoryConfig[];
  v3FactoryAddresses: Address[];
  balancerVaultAddress: Address;
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
    this.deps.activity("DISCOVERY", `Starting: ${protocol}`);
    let pools: Array<{ address: Address; protocol: string; tokens: Address[] }> = [];

    if (protocol === "curve") {
      const curvePools = await this.deps.fetchCurvePools("0x296d2B5C23833A70D07c8fCBB97d846c1ff90DDD");
      pools = curvePools.map((p) => ({ address: p.poolAddress, protocol: "curve", tokens: p.coins }));
    } else if (protocol === "balancer") {
      const vault = this.deps.balancerVaultAddress;
      const v3Pools = await this.deps.discoverV3Pools([vault]);
      pools = v3Pools.map((p) => ({ address: p.poolAddress, protocol: "balancer", tokens: [p.token0, p.token1] }));
    } else if (protocol.toLowerCase().includes("v2")) {
      this.deps.activity("DISCOVERY", `V2: discovering all V2 factories for ${protocol}...`);
      for (const factory of this.deps.v2Factories) {
        try {
          this.deps.activity("DISCOVERY", `V2: ${factory.label}...`);
          const v2Pools = await this.deps.fetchV2Pools(factory.address, factory.label);
          for (const p of v2Pools) {
            pools.push({ address: p.poolAddress, protocol: factory.label.toLowerCase(), tokens: [p.token0, p.token1] });
          }

          this.deps.activity("DISCOVERY", `V2: ${factory.label} → ${v2Pools.length} pools`);
        } catch (err) {
          this.deps.logger.error({ err, factory: factory.label }, "V2 discovery failed");
        }
      }
    } else if (protocol.toLowerCase().includes("v3")) {
      this.deps.activity("DISCOVERY", `V3: ${protocol} via HyperSync...`);
      const v3Pools = await this.deps.discoverV3Pools(this.deps.v3FactoryAddresses);
      pools = v3Pools.map((p) => ({ address: p.poolAddress, protocol: protocol.toLowerCase(), tokens: [p.token0, p.token1] }));
      this.deps.activity("DISCOVERY", `V3: ${protocol} → ${v3Pools.length} pools`);
    }

    for (const pool of pools) {
      await this.deps.savePool(pool);
    }

    this.deps.activity("DISCOVERY", `${protocol}: ${pools.length} pools saved`);
    this.deps.logger.info({ protocol, discovered: pools.length }, "Finished discovering protocol");
    return [];
  }

  async discoverAll(): Promise<number> {
    const protocols = ["curve", "quickswap_v2", "sushiswap_v2", "uniswap_v2", "quickswap_v3", "uniswap_v3", "sushiswap_v3", "balancer"];
    let total = 0;
    for (const p of protocols) {
      try {
        await this.discoverProtocol(p);
        total++;
      } catch (err) {
        this.deps.logger.error({ err, protocol: p }, "Discovery failed");
      }
    }
    return total;
  }
}
