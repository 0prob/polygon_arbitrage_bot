import type { Address } from "../../core/types/common.ts";

export interface SkimOpportunity {
  pairAddress: Address;
  token0: Address;
  token1: Address;
  imbalance0: bigint;
  imbalance1: bigint;
  profitableToken: '0' | '1';
}

export interface SkimConfig {
  factoryAddress: Address;
  scanIntervalMs: number;
  profitThresholdUsd: number;
}
