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
