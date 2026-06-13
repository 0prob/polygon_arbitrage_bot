import { ZERO_ADDRESS, KNOWN_FACTORIES_SET } from "./constants.ts";

/**
 * Basic defensive guards for pool discovery.
 */
export function isLikelyGarbagePair(token0: string, token1: string): boolean {
  const t0 = token0.toLowerCase();
  const t1 = token1.toLowerCase();
  return (
    t0 === ZERO_ADDRESS ||
    t1 === ZERO_ADDRESS ||
    KNOWN_FACTORIES_SET.has(t0) ||
    KNOWN_FACTORIES_SET.has(t1) ||
    t0 === t1
  );
}

/** Shared guard for factory PairCreated / PoolCreated (contractRegister + onEvent). */
export function shouldSkipFactoryPool(token0: string, token1: string, factoryAddr: string): boolean {
  return token0 === factoryAddr || token1 === factoryAddr || isLikelyGarbagePair(token0, token1);
}
