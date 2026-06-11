import { WMATIC } from "../config/addresses.ts";
import type { PoolMeta } from "../core/types/pool.ts";
import { isInvalidState } from "../core/types/pool.ts";
import { toBigInt } from "../core/utils/bigint.ts";
import { MAJOR_TOKEN_APPROX_RATES, RATE_PRECISION } from "../core/constants.ts";

const WMATIC_LOWER = WMATIC.toLowerCase();

interface NormalizedPool {
  addressLower: string;
  protocolLower: string;
  tokensLower: string[];
  pool: PoolMeta;
}

let _normalizedPoolsCache: { key: string; pools: NormalizedPool[] } | null = null;

function getNormalizedPools(pools: PoolMeta[]): NormalizedPool[] {
  const key = `${pools.length}:${pools[0]?.address ?? ""}`;
  if (_normalizedPoolsCache && _normalizedPoolsCache.key === key) {
    return _normalizedPoolsCache.pools;
  }
  const mapped = pools.map((p) => ({
    addressLower: p.address.toLowerCase(),
    protocolLower: p.protocol.toLowerCase(),
    tokensLower: (p.tokens ?? [p.token0, p.token1]).map((t) => t.toLowerCase()),
    pool: p,
  }));
  _normalizedPoolsCache = { key, pools: mapped };
  return mapped;
}

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
  stateCache: { get(key: string): Record<string, unknown> | undefined; has(key: string): boolean; size: number },
  /** Minimal pino-compatible logger (only debug/info used). */
  logger?: {
    debug?: (obj: Record<string, unknown>, msg?: string) => void;
    info?: (obj: Record<string, unknown>, msg?: string) => void;
  },
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

  rates.set(WMATIC_LOWER, RATE_PRECISION);

  // Additional bootstrap seeds for major bases to improve initial coverage and connected component.
  for (const [addr, rate] of MAJOR_TOKEN_APPROX_RATES) {
    rates.set(addr, rate);
  }

  const logs: string[] = [];
  if (logger) logs.push(`Starting rate propagation from WMATIC. Pools with state: ${stateCache.size}`);

  const minLiquidityV3 = options.minLiquidityV3 ?? 100_000_000_000_000_000n;

  let skippedNoState = 0;
  let skippedLowLiquidity = 0;
  let skippedExtremeRatio = 0;

  const focus = options.focusTokens;

  const normalizedPools = getNormalizedPools(pools);

  // Partition pools touching focus to the front instead of sorting (O(N) instead of O(N log N))
  let orderedPools: NormalizedPool[];
  if (focus && focus.size > 0) {
    const primary: NormalizedPool[] = [];
    const secondary: NormalizedPool[] = [];
    for (const np of normalizedPools) {
      let touches = false;
      for (const t of np.tokensLower) {
        if (focus.has(t)) {
          touches = true;
          break;
        }
      }
      if (touches) {
        primary.push(np);
      } else {
        secondary.push(np);
      }
    }
    orderedPools = primary.concat(secondary);
  } else {
    orderedPools = normalizedPools;
  }

  // Use a more thorough BFS-style propagation.
  for (let i = 0; i < 15; i++) {
    let changed = false;

    for (const np of orderedPools) {
      const addr = np.addressLower;
      const state = stateCache.get(addr);
      if (!state) {
        skippedNoState++;
        continue;
      }
      if (isInvalidState(state)) {
        skippedNoState++;
        continue;
      }

      const tokens = np.tokensLower;
      if (tokens.length < 2) continue;

      // Find which tokens already have a rate
      const isTwoTokens = tokens.length === 2;
      let knownIdx = -1;
      let singleUnknownIdx = -1;
      let unknownIndices: number[] | null = null;

      if (isTwoTokens) {
        const has0 = rates.has(tokens[0]);
        const has1 = rates.has(tokens[1]);
        if (has0 && !has1) {
          knownIdx = 0;
          singleUnknownIdx = 1;
        } else if (!has0 && has1) {
          knownIdx = 1;
          singleUnknownIdx = 0;
        } else {
          continue;
        }
      } else {
        const knownIndices: number[] = [];
        const localUnknownIndices: number[] = [];
        for (let j = 0; j < tokens.length; j++) {
          if (rates.has(tokens[j])) {
            knownIndices.push(j);
          } else {
            localUnknownIndices.push(j);
          }
        }
        if (knownIndices.length === 0 || localUnknownIndices.length === 0) continue;
        knownIdx = knownIndices[0];
        unknownIndices = localUnknownIndices;
      }

      // Propagate from the first known token to all unknown tokens
      const knownToken = tokens[knownIdx];
      const knownRate = rates.get(knownToken)!;

      const numUnknown = isTwoTokens ? 1 : unknownIndices!.length;
      for (let u = 0; u < numUnknown; u++) {
        const unknownIdx = isTwoTokens ? singleUnknownIdx : unknownIndices![u];
        const unknownToken = tokens[unknownIdx];

        try {
          // Protocol-specific spot price calculation
          const protocol = np.protocolLower;
          let newRate = 0n;
          let knownValueMatic = 0n;

          if (protocol.includes("v2")) {
            const r0 = toBigInt(state.reserve0, 0n);
            const r1 = toBigInt(state.reserve1, 0n);
            const rKnown = knownIdx === 0 ? r0 : r1;
            const rUnknown = unknownIdx === 0 ? r0 : r1;
            knownValueMatic = (knownRate * rKnown) / RATE_PRECISION;
            if (r0 > 0n && r1 > 0n) {
              newRate = (knownRate * rKnown) / rUnknown;
            }
          } else if (protocol.includes("v3") || protocol.includes("v4") || protocol.includes("elastic")) {
            const sq = toBigInt(state.sqrtPriceX96, 0n);
            const liq = toBigInt(state.liquidity, 0n);

            // Require some liquidity for rate propagation
            if (liq < minLiquidityV3) {
              skippedLowLiquidity++;
              continue;
            }

            if (sq > 0n) {
              const p192 = sq * sq;
              if (knownIdx === 0 && unknownIdx === 1) {
                newRate = (knownRate * (1n << 192n)) / p192;
                // Reserves for V3: x = L / P, y = L * P where P = sqrtPriceX96 / 2^96
                const xReserves = (liq << 96n) / sq;
                knownValueMatic = (knownRate * xReserves) / RATE_PRECISION;
              } else if (knownIdx === 1 && unknownIdx === 0) {
                newRate = (knownRate * p192) / (1n << 192n);
                const yReserves = (liq * sq) >> 96n;
                knownValueMatic = (knownRate * yReserves) / RATE_PRECISION;
              }
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
            const b = toBigInt(state.baseReserve ?? state.reserve0, 0n);
            const q = toBigInt(state.quoteReserve ?? state.reserve1, 0n);
            if (b > 0n && q > 0n) {
              const rKnown = knownIdx === 0 ? b : q;
              const rUnknown = unknownIdx === 0 ? b : q;
              knownValueMatic = (knownRate * rKnown) / RATE_PRECISION;
              newRate = (knownRate * rKnown) / rUnknown;
            }
          } else if (protocol.includes("woofi")) {
            const rawPrice = toBigInt(state.price, 0n);
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

          // Require at least ~0.001 MATIC worth of known token to propagate rate.
          if (knownValueMatic < 1_000_000_000_000_000n) {
            skippedLowLiquidity++;
            continue;
          }

          // SANITY CHECK: If newRate is astronomical (> 10^36), it's likely poisoned.
          if (newRate > 10n ** 36n) {
            skippedExtremeRatio++;
            continue;
          }

          // DEPTH CHECK: If the pool price ratio is extreme, it's likely a dead/broken pool.
          if (protocol.includes("v2")) {
            const r0 = toBigInt(state.reserve0, 0n);
            const r1 = toBigInt(state.reserve1, 0n);
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
            if (logger) logs.push(`Set rate for ${unknownToken}: ${newRate} (via ${np.pool.address} [${protocol}])`);
          }
        } catch (err) {
          logger?.debug?.({ err, pool: np.pool.address, protocol }, "Rate propagation failed for pool");
          continue;
        }
      }
    }
    if (!changed) break;
  }

  // Final targeted sweep when we have explicit focus tokens (the real P3 incremental win).
  // One extra cheap pass restricted only to pools that touch the dirty tokens.
  if (focus && focus.size > 0) {
    for (const np of normalizedPools) {
      let touches = false;
      for (const t of np.tokensLower) {
        if (focus.has(t)) {
          touches = true;
          break;
        }
      }
      if (!touches) continue;
      const addr = np.addressLower;
      const state = stateCache.get(addr);
      if (!state) continue;

      const tokens = np.tokensLower;
      if (tokens.length < 2) continue;

      const known = tokens.find((t) => rates.has(t));
      const unknown = tokens.find((t) => focus.has(t) && !rates.has(t));

      if (!known || !unknown) continue;

      const protocol = np.protocolLower;
      try {
        if (protocol.includes("v2")) {
          const r0 = toBigInt((state as Record<string, unknown>).reserve0, 0n);
          const r1 = toBigInt((state as Record<string, unknown>).reserve1, 0n);
          if (r0 > 0n && r1 > 0n) {
            const knownRate = rates.get(known)!;
            const kIdx = tokens.indexOf(known);
            const newRate = kIdx === 0 ? (knownRate * r0) / r1 : (knownRate * r1) / r0;
            if (newRate > 0n) rates.set(unknown, newRate);
          }
        } else if (protocol.includes("v3") || protocol.includes("v4")) {
          const sq = toBigInt((state as Record<string, unknown>).sqrtPriceX96, 0n);
          if (sq > 0n) {
            const knownRate = rates.get(known)!;
            const kIdx = tokens.indexOf(known);
            const p192 = sq * sq;
            const newRate = kIdx === 0 ? (knownRate * (1n << 192n)) / p192 : (knownRate * p192) / (1n << 192n);
            if (newRate > 0n && newRate < 10n ** 36n) rates.set(unknown, newRate);
          }
        }
      } catch (err) {
        logger?.debug?.({ err }, "Focus sweep rate propagation failed for pool");
      }
    }
  }

  if (logger && rates.size > 1) {
    logger.debug?.(
      { rates: rates.size, skippedNoState, skippedLowLiquidity, skippedExtremeRatio, propagation: logs },
      "Rate propagation complete",
    );
  } else if (logger) {
    logger.debug?.(
      {
        pools: pools.length,
        withState: stateCache.size,
        skippedNoState,
        skippedLowLiquidity,
        skippedExtremeRatio,
      },
      "Rate propagation failed to find any rates beyond WMATIC",
    );
  }
  return rates;
}
