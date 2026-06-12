import type { Address } from "../../core/types/common.ts";
import type { PoolState } from "../../core/types/pool.ts";

export interface LargeSwapSignal {
  traceId: string;
  txHash: string;
  poolAddress: Address;
  tokenIn: Address;
  tokenOut: Address;
  estimatedSwapSize: bigint;
  zeroForOne?: boolean;
  /** Optional RLP-encoded raw tx for FastLane bundle construction. */
  rawTx?: string;
}

export interface PoolStateInvalidatedSignal {
  addresses: Address[];
}

export interface PendingStateUpdateSignal {
  poolAddress: Address;
  state: PoolState;
}

export interface NewBlockSignal {
  number: number;
  hash: string;
  baseFee: bigint;
  timestamp: number;
}

export interface NewPoolPendingSignal {
  traceId: string;
  txHash: string;
  factoryAddress: Address;
}

export type MempoolSignal =
  | { type: "large_swap"; data: LargeSwapSignal }
  | { type: "pool_invalidated"; data: PoolStateInvalidatedSignal }
  | { type: "pending_state_update"; data: PendingStateUpdateSignal }
  | { type: "new_block"; data: NewBlockSignal }
  | { type: "new_pool_pending"; data: NewPoolPendingSignal };

export type SignalHandler = (signal: MempoolSignal) => void;
