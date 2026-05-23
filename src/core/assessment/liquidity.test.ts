import { describe, it, expect } from 'vitest';
import { calculateLiquidityUsd } from './liquidity';
import { PoolMeta, PoolState } from '../types/pool';

describe('calculateLiquidityUsd', () => {
  it('should calculate liquidity for V2 pool', () => {
    const pool: PoolMeta = {
      protocol: 'uniswap_v2',
      tokens: ['0x1', '0x2'],
      address: '0xabc',
      token0: '0x1',
      token1: '0x2',
    };
    const state: PoolState = {
      type: 'v2',
      reserve0: 1000000000000000000n, // 1 token0
      reserve1: 2000000000000000000n, // 2 token1
    };
    const tokenToMaticRate = 1000000000000000000n; // 1:1

    const result = calculateLiquidityUsd(pool, state, tokenToMaticRate);
    
    // 1 + 2 = 3 MATIC
    expect(result).toBe(3000000000000000000n);
  });

  it('should calculate liquidity for Curve pool', () => {
    const pool: PoolMeta = {
      protocol: 'curve',
      tokens: ['0x1', '0x2'],
      address: '0xabc',
      token0: '0x1',
      token1: '0x2',
    };
    const state: PoolState = {
      balances: [1000000000000000000n, 1000000000000000000n],
    };
    const tokenToMaticRate = 1000000000000000000n; // 1:1

    const result = calculateLiquidityUsd(pool, state, tokenToMaticRate);
    
    expect(result).toBe(2000000000000000000n);
  });

  it('should calculate liquidity for Dodo pool', () => {
    const pool: PoolMeta = {
      protocol: 'dodo',
      tokens: ['0x1', '0x2'],
      address: '0xabc',
      token0: '0x1',
      token1: '0x2',
    };
    const state: PoolState = {
      baseReserve: 1000000000000000000n,
      quoteReserve: 2000000000000000000n,
    };
    const tokenToMaticRate = 1000000000000000000n; // 1:1

    const result = calculateLiquidityUsd(pool, state, tokenToMaticRate);
    
    expect(result).toBe(3000000000000000000n);
  });

  it('should calculate liquidity for Woofi pool', () => {
    const pool: PoolMeta = {
      protocol: 'woofi',
      tokens: ['0x1', '0x2'],
      address: '0xabc',
      token0: '0x1',
      token1: '0x2',
    };
    const state: PoolState = {
      balances: [1000000000000000000n, 1000000000000000000n],
    };
    const tokenToMaticRate = 1000000000000000000n; // 1:1

    const result = calculateLiquidityUsd(pool, state, tokenToMaticRate);
    
    expect(result).toBe(2000000000000000000n);
  });
});
