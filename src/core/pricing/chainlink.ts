import type { Address } from "../types/common.ts";

export interface ChainlinkAnswer {
  /** Price in 8-decimal fixed point (Chainlink convention) */
  answer: bigint;
  /** Unix timestamp of last update */
  updatedAt: number;
  /** Round ID */
  roundId: bigint;
}

export interface ChainlinkFeedConfig {
  address: Address;
  decimals: number;
  /** Max age in seconds before answer is considered stale. Default: 300s (5min, tighter than current 1hr). */
  maxStalenessSec: number;
}

/** Default MATIC/USD feed on Polygon with 5-minute staleness. */
export const DEFAULT_MATIC_USD_FEED: ChainlinkFeedConfig = {
  address: "0xab594600376ec9fd91f8e885dadf0ce036862de0",
  decimals: 8,
  maxStalenessSec: 300,
};

/** Check whether a Chainlink answer is fresh. */
export function isFreshChainlinkAnswer(answer: ChainlinkAnswer, config: ChainlinkFeedConfig, nowSec: number): boolean {
  if (answer.answer <= 0n) return false;
  return nowSec - answer.updatedAt <= config.maxStalenessSec;
}

/** Check whether two price estimates agree within tolerance. */
export function pricesAgreeWithinBps(a: bigint, b: bigint, toleranceBps: bigint = 200n): boolean {
  if (a <= 0n || b <= 0n) return false;
  const diff = a > b ? a - b : b - a;
  const denom = a < b ? a : b;
  return (diff * 10_000n) / denom <= toleranceBps;
}
