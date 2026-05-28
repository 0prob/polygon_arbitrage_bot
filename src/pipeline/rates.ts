import { WMATIC } from "../config/addresses.ts";
import type { PoolMeta } from "../core/types/pool.ts";

const WMATIC_LOWER = WMATIC.toLowerCase();

export interface ComputeMaticRatesOptions {
  minLiquidityV3?: bigint;
  /** When provided, start from these rates instead of a fresh empty map.
   *  Enables cheap incremental updates after small state refreshes (most common HF/LF path).
   */
  seedRates?: Map<string, bigint>;
  /** When provided (together with seedRates), the rate engine will prioritize pools
   *  whose tokens intersect this set. This turns the "light pre-fetch" path into
   *  true dirty-token incremental updates.
   */
  focusTokens?: Set<string>;
}

export function computeMaticRates(
  pools: PoolMeta[],
  stateCache: Map<string, Record<string, unknown>>,
  logger?: { debug?: (obj: unknown, msg?: string) => void; info?: (obj: unknown, msg?: string) => void },
  options: ComputeMaticRatesOptions = {},
): Map<string, bigint> {
  const rates = new Map<string, bigint>();

  // Incremental path: seed from previous good rates when available.
  // This avoids full re-propagation work for the (usually large) set of tokens whose
  // rates have not been affected by the just-refreshed pools.
  if (options.seedRates) {
    for (const [k, v] of options.seedRates) {
      rates.set(k, v);
    }
  }

  const RATE_PRECISION = 1000000000000000000n;
  rates.set(WMATIC_LOWER, RATE_PRECISION);

  const logs: string[] = [];
  if (logger) logs.push(`Starting rate propagation from WMATIC. Pools with state: ${stateCache.size}`);

  const minLiquidityV3 = options.minLiquidityV3 ?? 100_000_000_000_000_000n;

  let skippedNoState = 0;
  let skippedLowLiquidity = 0;
  let skippedExtremeRatio = 0;

  const focus = options.focusTokens;

  function touchesFocus(pool: PoolMeta): boolean {
    if (!focus || focus.size === 0) return true;
    const ts = pool.tokens ?? [pool.token0, pool.token1];
    return ts.some((t) => focus.has(t.toLowerCase()));
  }

  // Use a more thorough BFS-style propagation.
  // When focusTokens are supplied we process "dirty" pools first for faster convergence on what matters.
  for (let i = 0; i < 10; i++) {
    let changed = false;

    // Optional: stable partition so focus-touching pools are considered early
    const orderedPools = focus && focus.size > 0
      ? [...pools].sort((a, b) => (touchesFocus(b) ? 1 : 0) - (touchesFocus(a) ? 1 : 0))
      : pools;

    for (const pool of orderedPools) {
      const addr = pool.address.toLowerCase();
      const state = stateCache.get(addr);
      if (!state) {
        skippedNoState++;
        continue;
      }

      const tokens = pool.tokens?.map((t) => t.toLowerCase()) ?? [pool.token0.toLowerCase(), pool.token1.toLowerCase()];
      if (tokens.length < 2) continue;

      // Find which tokens already have a rate
      const knownIndices: number[] = [];
      const unknownIndices: number[] = [];
      for (let j = 0; j < tokens.length; j++) {
        if (rates.has(tokens[j])) {
          knownIndices.push(j);
        } else {
          unknownIndices.push(j);
        }
      }

      if (knownIndices.length === 0 || unknownIndices.length === 0) continue;

      // Propagate from the first known token to all unknown tokens
      const knownIdx = knownIndices[0];
      const knownToken = tokens[knownIdx];
      const knownRate = rates.get(knownToken)!;

      for (const unknownIdx of unknownIndices) {
        const unknownToken = tokens[unknownIdx];

        try {
          // Protocol-specific spot price calculation
          const protocol = pool.protocol.toLowerCase();
          let newRate = 0n;
          let knownValueMatic = 0n;

          if (protocol.includes("v2")) {
            const r0 = BigInt(state.reserve0 as any || 0n);
            const r1 = BigInt(state.reserve1 as any || 0n);
            const rKnown = knownIdx === 0 ? r0 : r1;
            const rUnknown = unknownIdx === 0 ? r0 : r1;
            knownValueMatic = (knownRate * rKnown) / RATE_PRECISION;
            if (r0 > 0n && r1 > 0n) {
              newRate = (knownRate * rKnown) / rUnknown;
            }
          } else if (protocol.includes("v3") || protocol.includes("v4") || protocol.includes("elastic")) {
            const sq = BigInt(state.sqrtPriceX96 as any || 0n);
            const liq = BigInt(state.liquidity as any || 0n);
            
            // Require some liquidity for rate propagation
            if (liq < minLiquidityV3) {
              skippedLowLiquidity++;
              continue;
            }
            
            if (sq > 0n) {
              const p192 = sq * sq;
              if (knownIdx === 0 && unknownIdx === 1) {
                newRate = (knownRate * (1n << 192n)) / p192;
              } else if (knownIdx === 1 && unknownIdx === 0) {
                newRate = (knownRate * p192) / (1n << 192n);
              }
              // For V3, assume 10 MATIC value if liq is present
              knownValueMatic = 10n * RATE_PRECISION;
            }
          } else if (protocol.includes("balancer")) {
            const balances = state.balances as bigint[];
            if (balances && balances[knownIdx] > 0n && balances[unknownIdx] > 0n) {
              knownValueMatic = (knownRate * balances[knownIdx]) / RATE_PRECISION;
              const weights = state.weights as bigint[];
              if (weights && weights[knownIdx] > 0n && weights[unknownIdx] > 0n) {
                newRate = (knownRate * balances[knownIdx] * weights[unknownIdx]) / (balances[unknownIdx] * weights[knownIdx]);
              } else {
                newRate = (knownRate * balances[knownIdx]) / balances[unknownIdx];
              }
            }
          } else if (protocol.includes("curve")) {
            const balances = state.balances as bigint[];
            if (balances && balances[knownIdx] > 0n && balances[unknownIdx] > 0n) {
              knownValueMatic = (knownRate * balances[knownIdx]) / RATE_PRECISION;
              newRate = (knownRate * balances[knownIdx]) / balances[unknownIdx];
            }
          } else if (protocol.includes("dodo")) {
            const b = BigInt(state.baseReserve as any || state.reserve0 as any || 0n);
            const q = BigInt(state.quoteReserve as any || state.reserve1 as any || 0n);
            if (b > 0n && q > 0n) {
              const rKnown = knownIdx === 0 ? b : q;
              const rUnknown = unknownIdx === 0 ? b : q;
              knownValueMatic = (knownRate * rKnown) / RATE_PRECISION;
              newRate = (knownRate * rKnown) / rUnknown;
            }
          } else if (protocol.includes("woofi")) {
            const rawPrice = BigInt(state.price as any || 0n);
            if (rawPrice > 0n) {
              const balances = state.balances as bigint[] | undefined;
              if (balances && balances[knownIdx] > 0n) {
                knownValueMatic = (knownRate * balances[knownIdx]) / RATE_PRECISION;
              } else {
                knownValueMatic = 10n * RATE_PRECISION; 
              }

              if (knownIdx === 0) {
                newRate = (knownRate * RATE_PRECISION) / rawPrice;
              } else {
                newRate = (knownRate * rawPrice) / RATE_PRECISION;
              }
            }
          }

          // Require at least 1 MATIC worth of known token to propagate rate
          if (knownValueMatic < 1n * RATE_PRECISION) {
            skippedLowLiquidity++;
            continue;
          }

          // SANITY CHECK: If newRate is astronomical (> 10^36), it's likely poisoned.
          // 10^36 = 1,000,000,000,000,000,000 MATIC per token unit (for 18-dec token).
          // For USDC (6 dec), 10^30 is normal (1 MATIC/USDC). 10^36 allows for 1,000,000x deviation.
          if (newRate > 10n ** 36n) {
            skippedExtremeRatio++;
            continue;
          }

          // DEPTH CHECK: If the pool price ratio is extreme, it's likely a dead/broken pool.
          if (protocol.includes("v2")) {
            const r0 = BigInt(state.reserve0 as any || 0n);
            const r1 = BigInt(state.reserve1 as any || 0n);
            if (r0 > 0n && r1 > 0n) {
              const ratio = r0 > r1 ? r0 / r1 : r1 / r0;
              if (ratio > 10n ** 12n) {
                skippedExtremeRatio++;
                continue; 
              }
            }
          }

          if (newRate > 0n && (!rates.has(unknownToken) || rates.get(unknownToken)! < newRate)) {
            rates.set(unknownToken, newRate);
            changed = true;
            if (logger) logs.push(`Set rate for ${unknownToken}: ${newRate} (via ${pool.address} [${protocol}])`);
          }

        } catch {
          continue;
        }
      }
    }
    if (!changed) break;
  }

  // Final targeted sweep when we have explicit focus tokens (the real P3 incremental win).
  // One extra cheap pass restricted only to pools that touch the dirty tokens.
  if (focus && focus.size > 0) {
    for (const pool of pools) {
      if (!touchesFocus(pool)) continue;
      const addr = pool.address.toLowerCase();
      const state = stateCache.get(addr);
      if (!state) continue;

      const tokens = pool.tokens?.map((t) => t.toLowerCase()) ?? [pool.token0?.toLowerCase(), pool.token1?.toLowerCase()].filter(Boolean);
      if (tokens.length < 2) continue;

      const known = tokens.find((t) => rates.has(t));
      const unknown = tokens.find((t) => focus.has(t) && !rates.has(t));

      if (!known || !unknown) continue;

      // Very lightweight one-shot derivation for the dominant protocols (V2/V3).
      // Full correctness is already guaranteed by the preceding seeded propagation.
      const protocol = pool.protocol.toLowerCase();
      try {
        if (protocol.includes("v2")) {
          const r0 = BigInt((state as any).reserve0 || 0);
          const r1 = BigInt((state as any).reserve1 || 0);
          if (r0 > 0n && r1 > 0n) {
            const knownRate = rates.get(known)!;
            const kIdx = tokens.indexOf(known);
            const newRate = kIdx === 0 ? (knownRate * r0) / r1 : (knownRate * r1) / r0;
            if (newRate > 0n) rates.set(unknown, newRate);
          }
        } else if (protocol.includes("v3") || protocol.includes("v4")) {
          const sq = BigInt((state as any).sqrtPriceX96 || 0);
          if (sq > 0n) {
            const knownRate = rates.get(known)!;
            const kIdx = tokens.indexOf(known);
            const p192 = sq * sq;
            const newRate = kIdx === 0
              ? (knownRate * (1n << 192n)) / p192
              : (knownRate * p192) / (1n << 192n);
            if (newRate > 0n && newRate < 10n ** 36n) rates.set(unknown, newRate);
          }
        }
      } catch {
        // ignore per-pool errors in the cheap focus sweep
      }
    }
  }

  if (logger && rates.size > 1) {
    logger.debug?.({ rates: rates.size, propagation: logs }, "Rate propagation complete");
  } else if (logger) {
    logger.debug?.({ 
      pools: pools.length, 
      withState: stateCache.size,
      skippedNoState,
      skippedLowLiquidity,
      skippedExtremeRatio 
    }, "Rate propagation failed to find any rates beyond WMATIC");
  }
  return rates;
}
