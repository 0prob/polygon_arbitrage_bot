import type { Address } from "../../core/types/common.ts";

export interface LargeSwapSignal {
  txHash: string;
  poolAddress: Address;
  tokenIn: Address;
  tokenOut: Address;
  estimatedSwapSize: bigint;
}

export interface PoolStateInvalidatedSignal {
  addresses: Address[];
}

export interface NewBlockSignal {
  number: number;
  hash: string;
  baseFee: bigint;
  timestamp: number;
}

export type MempoolSignal =
  | { type: "large_swap"; data: LargeSwapSignal }
  | { type: "pool_invalidated"; data: PoolStateInvalidatedSignal }
  | { type: "new_block"; data: NewBlockSignal };

export type SignalHandler = (signal: MempoolSignal) => void;
