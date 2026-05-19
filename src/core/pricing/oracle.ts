import type { Address } from "../types/common.ts";

/**
 * Token-to-MATIC price oracle interface.
 *
 * Implementations:
 * - LivePriceOracle: composes V2/V3 pool quotes + Chainlink cross-check (in Phase 2 services layer)
 * - FixedPriceOracle: returns fixed rates (for testing)
 *
 * The oracle returns the number of MATIC wei equivalent to 1 smallest unit of the token.
 * Returns null when the rate is unknown or stale beyond tolerance.
 */
export interface PriceOracle {
  /** Get the MATIC-wei value per smallest token unit. Returns null if unavailable. */
  getTokenToMaticRate(token: Address): bigint | null;
  /** Get the MATIC-wei value per smallest token unit, or use a stale value within `maxStalenessMs`. */
  getTokenToMaticRateAllowStale(token: Address, maxStalenessMs: number): bigint | null;
  /** Check whether the oracle has a usable rate for a token. */
  hasRate(token: Address): boolean;
  /** Get the timestamp (ms) of the last update for a token. */
  lastUpdateMs(token: Address): number | null;
}

/** Fixed-rate oracle for testing. */
export class FixedPriceOracle implements PriceOracle {
  private updatedAt = new Map<string, number>();

  constructor(
    private rates: Map<Address, bigint>,
    private now: () => number = Date.now,
  ) {}

  getTokenToMaticRate(token: Address): bigint | null {
    return this.rates.get(token.toLowerCase() as Address) ?? null;
  }
  getTokenToMaticRateAllowStale(token: Address, _maxStalenessMs: number): bigint | null {
    return this.getTokenToMaticRate(token);
  }
  hasRate(token: Address): boolean {
    return this.rates.has(token.toLowerCase() as Address);
  }
  lastUpdateMs(token: Address): number | null {
    return this.updatedAt.get(token.toLowerCase() as Address) ?? null;
  }
  /** Test helper: update or insert a rate. */
  setRate(token: Address, rate: bigint): void {
    const key = token.toLowerCase() as Address;
    this.rates.set(key, rate);
    this.updatedAt.set(key, this.now());
  }
}
