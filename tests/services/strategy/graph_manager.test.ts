import { describe, it, expect } from 'vitest';
import { GraphManager } from '../../src/services/strategy/graph_manager';
import type { PoolMeta } from '../../src/core/types/pool';
import type { PoolState } from '../../src/core/types/pool';

describe('GraphManager', () => {
  it('should update pool state correctly', () => {
    const poolAddr = '0x123' as `0x${string}`;
    const pool: PoolMeta = {
      address: poolAddr,
      protocol: 'uniswap_v3',
      token0: '0xa',
      token1: '0xb',
      tokens: ['0xa', '0xb'],
    };
    const state: PoolState = {
        sqrtPriceX96: 100n,
        liquidity: 1000n,
        tick: 1
    };
    const cache = new Map<string, unknown>();
    cache.set(poolAddr.toLowerCase(), state);

    const manager = new GraphManager([pool], cache);
    
    const newState: PoolState = {
        sqrtPriceX96: 200n,
        liquidity: 2000n,
        tick: 2
    };
    manager.updatePool(poolAddr, newState);
    
    expect(manager.graph.stateRefs.get(poolAddr.toLowerCase())).toEqual(newState);
    
    for (const edges of manager.graph.adjacency.values()) {
        for (const edge of edges) {
            if (edge.poolAddress.toLowerCase() === poolAddr.toLowerCase()) {
                expect(edge.stateRef).toEqual(newState);
            }
        }
    }
  });
});
