import { describe, it, expect } from 'vitest';
import { GraphManager } from '../../../src/services/strategy/graph_manager.ts';
import type { PoolMeta } from '../../../src/core/types/pool';
import type { PoolState } from '../../../src/core/types/pool';

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

  it('should add a new pool correctly', () => {
    const manager = new GraphManager([], new Map());
    
    const poolAddr = '0x456' as `0x${string}`;
    const pool: PoolMeta = {
      address: poolAddr,
      protocol: 'uniswap_v2',
      token0: '0xc',
      token1: '0xd',
      tokens: ['0xc', '0xd'],
      fee: 3000
    };
    const state: PoolState = {
      reserve0: 1000n,
      reserve1: 1000n
    } as any;
    
    manager.addPool(pool, state);
    
    expect(manager.graph.poolMeta.get(poolAddr.toLowerCase())).toEqual(pool);
    expect(manager.graph.stateRefs.get(poolAddr.toLowerCase())).toEqual(state);
    
    const tokenCEdges = manager.graph.adjacency.get('0xc');
    expect(tokenCEdges).toBeDefined();
    expect(tokenCEdges?.length).toBe(1);
    expect(tokenCEdges![0]).toMatchObject({
      poolAddress: poolAddr,
      protocol: 'uniswap_v2',
      tokenIn: '0xc',
      tokenOut: '0xd',
      feeBps: 3000n,
      stateRef: state,
      zeroForOne: true,
      tokenInIdx: 0,
      tokenOutIdx: 1
    });

    const tokenDEdges = manager.graph.adjacency.get('0xd');
    expect(tokenDEdges).toBeDefined();
    expect(tokenDEdges?.length).toBe(1);
    expect(tokenDEdges![0]).toMatchObject({
      poolAddress: poolAddr,
      protocol: 'uniswap_v2',
      tokenIn: '0xd',
      tokenOut: '0xc',
      feeBps: 3000n,
      stateRef: state,
      zeroForOne: false,
      tokenInIdx: 1,
      tokenOutIdx: 0
    });
    
    expect(manager.graph.tokens.has('0xc')).toBe(true);
    expect(manager.graph.tokens.has('0xd')).toBe(true);
  });
});
