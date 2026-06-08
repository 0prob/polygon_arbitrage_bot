import type { Address } from "./common.ts";
import type { PoolState } from "./pool.ts";

/**
 * Internal dict-based state override format.
 * Easier to build and merge than viem's array format.
 * Convert with toViemStateOverride() before passing to client.call().
 */
export interface StateOverride {
  [address: `0x${string}`]: {
    stateDiff?: Record<string, string>;
    code?: `0x${string}`;
    balance?: string;
    nonce?: string;
  };
}

export function toViemStateOverride(override: StateOverride): Array<{
  address: `0x${string}`;
  balance?: bigint;
  nonce?: number;
  code?: `0x${string}`;
  stateDiff?: Array<{ slot: `0x${string}`; value: `0x${string}` }>;
  state?: Array<{ slot: `0x${string}`; value: `0x${string}` }>;
}> {
  return Object.entries(override).map(([address, entry]) => {
    const result: any = { address: address as `0x${string}` };
    if (entry.stateDiff) {
      result.stateDiff = Object.entries(entry.stateDiff).map(([slot, value]) => ({
        slot: slot as `0x${string}`,
        value: value as `0x${string}`,
      }));
    }
    if (entry.code !== undefined && entry.code !== null) result.code = entry.code;
    if (entry.balance !== undefined && entry.balance !== null) result.balance = BigInt(entry.balance);
    if (entry.nonce !== undefined && entry.nonce !== null) result.nonce = Number(entry.nonce);
    return result;
  });
}

export function mergeStateOverride(target: StateOverride, source: StateOverride): void {
  for (const [addr, diff] of Object.entries(source)) {
    const key = addr as `0x${string}`;
    if (!target[key]) {
      target[key] = {};
    }
    const entry = target[key]!;

    if (diff.stateDiff) {
      entry.stateDiff = { ...entry.stateDiff, ...diff.stateDiff };
    }
    if (diff.code !== undefined && diff.code !== null) {
      entry.code = diff.code;
    }
    if (diff.balance !== undefined && diff.balance !== null) {
      entry.balance = diff.balance;
    }
    if (diff.nonce !== undefined && diff.nonce !== null) {
      entry.nonce = diff.nonce;
    }
  }
}

export type OverrideProtocol = "V2" | "V3" | "V4" | "BALANCER" | "CURVE" | "DODO" | "WOOFI";

export interface ProtocolStateDelta {
  poolAddress: Address;
  protocol: OverrideProtocol;
  storageChanges: Record<string, bigint>;
}

export interface PendingTxSimulation {
  txHash: string;
  stateOverride: StateOverride;
  affectedPools: string[];
  timestamp: number;
}

export interface PendingOverrideEntry {
  override: StateOverride;
  affectedPools: Set<string>;
  timestamp: number;
  txHashes: string[];
}

export interface BuildOverrideInput {
  poolAddress: Address;
  protocol: string;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  zeroForOne?: boolean;
  fee?: number;
  swapFeeBps?: number;
  tokenInIdx?: number;
  tokenOutIdx?: number;
  poolId?: string;
  currentState: PoolState;
  /** V4-specific: PoolManager address */
  poolManagerAddress?: Address;
  /** V4-specific: PoolKey components */
  currency0?: Address;
  currency1?: Address;
  hooks?: Address;
  tickSpacing?: number;
}

export interface StateOverrideBuilderDeps {
  simulateV2Swap: (
    state: PoolState,
    amountIn: bigint,
    zeroForOne: boolean,
    numerator: bigint,
    denominator: bigint,
  ) => { amountOut: bigint; newReserve0: bigint; newReserve1: bigint };
  simulateV3Swap: (
    state: PoolState,
    amountIn: bigint,
    zeroForOne: boolean,
    fee?: number,
  ) => { amountOut: bigint; sqrtPriceX96: bigint; liquidity: bigint; tick: number };
  simulateBalancerSwap: (
    amountIn: bigint,
    state: PoolState,
    tokenInIdx: number,
    tokenOutIdx: number,
  ) => { amountOut: bigint; newBalances: bigint[] };
  simulateCurveSwap: (
    amountIn: bigint,
    state: PoolState,
    tokenInIdx: number,
    tokenOutIdx: number,
  ) => { amountOut: bigint; newBalances: bigint[] };
  simulateDodoSwap: (
    state: PoolState,
    amountIn: bigint,
    zeroForOne: boolean,
  ) => { amountOut: bigint; newBaseReserve: bigint; newQuoteReserve: bigint };
  simulateWoofiSwap: (
    amountIn: bigint,
    state: PoolState,
    tokenInIdx: number,
    tokenOutIdx: number,
  ) => { amountOut: bigint; newPrice: bigint; newBaseAmount: bigint; newQuoteAmount: bigint };
}

/** V4 PoolManager storage slot for the _pools mapping (mapping(bytes32 => Pool.State)) */
export const V4_POOLS_MAPPING_SLOT = 0n;

export interface V4PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

/** Default PoolManager address for Uniswap V4 on Polygon */
export const DEFAULT_POOL_MANAGER_ADDRESS = "0x67366782805870060151383f4bbff9dab53e5cd6" as Address;
