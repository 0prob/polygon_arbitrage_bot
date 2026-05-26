import { type PublicClient, type Address, parseAbiItem, getAddress } from "viem";
import type { Logger } from "../../infra/observability/logger.ts";
import type { PoolMeta } from "../../core/types/pool.ts";

const V2_FACTORY_ABI = parseAbiItem("event PairCreated(address indexed token0, address indexed token1, address pair, uint)");
const V3_FACTORY_ABI = parseAbiItem("event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)");

export interface DiscoveryOptions {
  v2Factories: Address[];
  v3Factories: Address[];
  onNewPool: (pool: PoolMeta) => void;
}

/**
 * Listens for pool creation events in the mempool/logs.
 * Allows the bot to find new liquidity immediately without waiting for HyperIndex.
 */
export class JITPoolDiscovery {
  constructor(
    private client: PublicClient,
    private logger: Logger,
    private options: DiscoveryOptions
  ) {}

  async start(): Promise<void> {
    this.logger.info({ 
      v2Count: this.options.v2Factories.length, 
      v3Count: this.options.v3Factories.length 
    }, "Starting JIT Pool Discovery");

    // Watch V2 Factories
    for (const factory of this.options.v2Factories) {
      this.client.watchEvent({
        address: factory,
        event: V2_FACTORY_ABI,
        onLogs: (logs) => {
          for (const log of logs) {
            const args = log.args as any;
            const { token0, token1, pair } = args;
            if (token0 && token1 && pair) {
              this.logger.info({ pair, token0, token1, factory }, "New V2 Pool Discovered JIT");
              this.options.onNewPool({
                address: getAddress(pair),
                protocol: "v2", // Canonical type
                token0: getAddress(token0),
                token1: getAddress(token1),
                tokens: [getAddress(token0), getAddress(token1)]
              });
            }
          }
        }
      });
    }

    // Watch V3 Factories
    for (const factory of this.options.v3Factories) {
      this.client.watchEvent({
        address: factory,
        event: V3_FACTORY_ABI,
        onLogs: (logs) => {
          for (const log of logs) {
            const args = log.args as any;
            const { token0, token1, fee, pool } = args;
            if (token0 && token1 && pool) {
              this.logger.info({ pool, token0, token1, fee, factory }, "New V3 Pool Discovered JIT");
              this.options.onNewPool({
                address: getAddress(pool),
                protocol: "v3",
                token0: getAddress(token0),
                token1: getAddress(token1),
                tokens: [getAddress(token0), getAddress(token1)],
                fee: Number(fee)
              });
            }
          }
        }
      });
    }
  }
}
