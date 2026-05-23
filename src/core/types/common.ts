/** Branded EVM address type */
export type Address = `0x${string}`;
/** Flexible bigint input */
export type BigIntLike = bigint | string | number;
/** Structured logger function */
export type LoggerFn = (msg: string, ...args: unknown[]) => void;
/** Log levels */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "silent";
/** Gas fee snapshot at a point in time */
export interface FeeSnapshot {
  baseFee: bigint;
  priorityFee: bigint;
  maxFee: bigint;
  gasPrice: bigint;
  timestamp: number;
}
/** Token metadata */
export interface TokenMetadata {
  address: Address;
  decimals: number;
  symbol?: string;
  name?: string;
}
