import type { PublicClient, Address } from "viem";
import type { PoolState } from "../../core/types/pool.ts";

export interface SubscriberOptions {
  client: PublicClient;
  onPoolUpdate: (poolAddress: Address, state: PoolState) => void;
}

export class PoolStateSubscriber {
  private client: PublicClient;
  private onPoolUpdate: (poolAddress: Address, state: PoolState) => void;

  constructor(opts: SubscriberOptions) {
    this.client = opts.client;
    this.onPoolUpdate = opts.onPoolUpdate;
  }

  async subscribe(poolAddress: Address) {
    this.client.watchContractEvent({
        address: poolAddress,
        abi: [{
            type: 'event',
            name: 'Swap',
            inputs: [
                { type: 'address', name: 'sender', indexed: true },
                { type: 'address', name: 'recipient', indexed: true },
                { type: 'int256', name: 'amount0' },
                { type: 'int256', name: 'amount1' },
                { type: 'uint160', name: 'sqrtPriceX96' },
                { type: 'uint128', name: 'liquidity' },
                { type: 'int24', name: 'tick' },
            ]
        }],
        eventName: 'Swap',
        onLogs: (logs) => {
            for (const log of logs) {
                this.onPoolUpdate(poolAddress, {
                    sqrtPriceX96: log.args.sqrtPriceX96,
                    liquidity: log.args.liquidity,
                    tick: log.args.tick
                });
            }
        }
    });
  }
}
