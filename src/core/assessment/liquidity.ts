import { PoolMeta, PoolState } from '../types/pool';

export function calculateLiquidityUsd(
  pool: PoolMeta,
  state: PoolState,
  tokenToMaticRate: bigint
): bigint {
  switch (pool.protocol) {
    case 'uniswap_v2':
    case 'sushiswap_v2': {
      const { reserve0, reserve1 } = state as any;
      return (reserve0 + reserve1) * tokenToMaticRate / 10n ** 18n;
    }
    case 'uniswap_v3': {
      const { liquidity } = state as any;
      return liquidity * tokenToMaticRate / 10n ** 18n;
    }
    case 'curve':
    case 'balancer': {
      const { balances } = state as any;
      return balances.reduce((a: bigint, b: bigint) => a + b, 0n) * tokenToMaticRate / 10n ** 18n;
    }
    case 'dodo': {
      const { baseReserve, quoteReserve } = state as any;
      return (baseReserve + quoteReserve) * tokenToMaticRate / 10n ** 18n;
    }
    case 'woofi': {
      const { balances } = state as any;
      return balances.reduce((a: bigint, b: bigint) => a + b, 0n) * tokenToMaticRate / 10n ** 18n;
    }
    default:
      throw new Error(`Unsupported protocol: ${pool.protocol}`);
  }
}
