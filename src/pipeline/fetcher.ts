import { parseAbi } from "viem";
import type { PublicClient } from "viem";
import { toBigInt } from "../core/utils/bigint.ts";
import { BoundedMap } from "../core/utils/bounded_map.ts";
import { INVALID_POOL_STATE } from "../core/types/pool.ts";
import type { PoolMeta } from "../core/types/pool.ts";
import type { FoundCycle } from "./types.ts";
import type { RouteStateCache } from "../core/types/route.ts";
import { markAsGarbage } from "../infra/garbage/garbage-tracker.ts";
import { fingerprintPools } from "../core/utils/pool_fingerprint.ts";
import { logSampled, METRICS_INTERVAL, type MetricsLogger } from "../infra/observability/metrics.ts";
const ERC20_ABI = parseAbi(["function balanceOf(address account) external view returns (uint256)"]);

const V2_ABI = parseAbi(["function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)"]);
const DODO_ABI = parseAbi([
  "function _I_() external view returns (uint256)",
  "function _K_() external view returns (uint256)",
  "function _BASE_RESERVE_() external view returns (uint256)",
  "function _QUOTE_RESERVE_() external view returns (uint256)",
  "function _BASE_TARGET_() external view returns (uint256)",
  "function _QUOTE_TARGET_() external view returns (uint256)",
  "function _R_STATUS_() external view returns (uint8)",
  "function _LP_FEE_RATE_() external view returns (uint256)",
  "function _MT_FEE_RATE_() external view returns (uint256)",
]);
const V3_ABI = parseAbi([
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() external view returns (uint128)",
]);
const ELASTIC_ABI = parseAbi([
  "function getPoolState() external view returns (uint160 sqrtP, int24 currentTick, int24 nearestCurrentTick, bool locked)",
  "function liquidity() external view returns (uint128)",
]);
const V4_ABI = parseAbi([
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() external view returns (uint128)",
  "function fee() external view returns (uint24)",
  "function tickSpacing() external view returns (int24)",
  "function hooks() external view returns (address)",
]);
const WOOFI_PAIR_ABI = parseAbi(["function price() external view returns (uint256)", "function fee() external view returns (uint256)"]);
const VAULT_ABI = parseAbi([
  "function getPoolTokens(bytes32 poolId) external view returns (address[] tokens, uint256[] balances, uint256 lastChangeBlock)",
]);
const BALANCER_ABI = parseAbi([
  "function getSwapFeePercentage() external view returns (uint256)",
  "function getNormalizedWeights() external view returns (uint256[])",
  "function getScalingFactors() external view returns (uint256[])",
]);
const CURVE_ABI = parseAbi([
  "function A() external view returns (uint256)",
  "function fee() external view returns (uint256)",
  "function balances(uint256 i) external view returns (uint256)",
  "function rates(uint256 i) external view returns (uint256)",
]);

const _failedPools = new BoundedMap<string, { count: number }>({ maxSize: 10_000, ttlMs: 10 * 60 * 1000 });
/** Per-pool last successful fetch time — avoids refetching every HF tick when state is still fresh. */
const _lastFetchedAt = new BoundedMap<string, number>({ maxSize: 50_000, ttlMs: 30 * 60 * 1000 });
const POOL_STATE_STALE_MS = 2500;

function trackFailedPool(
  addr: string,
  reason: string,
  stateCache: RouteStateCache,
  logger?: MetricsLogger,
): void {
  const existing = _failedPools.get(addr);
  const newCount = (existing?.count ?? 0) + 1;
  _failedPools.set(addr, { count: newCount });

  if (newCount >= 3) {
    if (newCount === 3) {
      logger?.warn?.({ pool: addr, reason }, "Marking pool INVALID after 3 fetch failures");
    }
    stateCache.set(addr, INVALID_POOL_STATE);
  }
}

export function resetFetcherCachesForTests(): void {
  _failedPools.clear();
  _lastFetchedAt.clear();
  _poolLookupCache = null;
}

/** Clear per-pool fetch cooldowns after chain reorg or full state invalidation. */
export function clearPoolFetchTracking(): void {
  _failedPools.clear();
  _lastFetchedAt.clear();
}

function trackSuccessfulPool(
  addr: string,
  stateCache: RouteStateCache,
  state: Record<string, unknown>,
  updated: Set<string>,
): void {
  stateCache.set(addr, state);
  updated.add(addr);
  _failedPools.delete(addr);
  _lastFetchedAt.set(addr, Date.now());
}

let _poolLookupCache: { fingerprint: string; lookup: Map<string, PoolMeta> } | null = null;
function buildPoolLookup(pools: PoolMeta[], staticAnchors: readonly { address: string }[]): Map<string, PoolMeta> {
  const fingerprint = fingerprintPools(pools) + `:${staticAnchors.length}`;
  if (_poolLookupCache && _poolLookupCache.fingerprint === fingerprint) {
    return _poolLookupCache.lookup;
  }
  const lookup = new Map<string, PoolMeta>();
  for (const p of pools) {
    lookup.set(p.address.toLowerCase(), p);
  }
  for (const anchor of staticAnchors) {
    const addr = anchor.address.toLowerCase();
    if (!lookup.has(addr)) {
      lookup.set(addr, anchor as PoolMeta);
    }
  }
  _poolLookupCache = { fingerprint, lookup };
  return lookup;
}

export async function fetchMissingPoolState(
  publicClient: PublicClient,
  stateCache: RouteStateCache,
  pools: PoolMeta[],
  currentCycles: FoundCycle[],
  staticAnchors: readonly { address: string }[] = [],
  forceRefresh: boolean = false,
  logger?: {
    debug?: (obj: Record<string, unknown>, msg?: string) => void;
    error?: (obj: Record<string, unknown>, msg?: string) => void;
    warn?: (obj: Record<string, unknown>, msg?: string) => void;
  },
): Promise<Set<string>> {
  const missingAddresses = new Set<string>();
  const fetchNow = Date.now();

  const updated = new Set<string>();

  if (forceRefresh) {
    // Full refresh path: use the authoritative pools list (no need for dummy cycles anymore)
    for (const p of pools) {
      missingAddresses.add(p.address.toLowerCase());
    }
    for (const anchor of staticAnchors) {
      missingAddresses.add(anchor.address.toLowerCase());
    }
  } else {
    for (const anchor of staticAnchors) {
      const addr = anchor.address.toLowerCase();
      if (!stateCache.has(addr)) {
        missingAddresses.add(addr);
      }
    }

    for (const cycle of currentCycles) {
      for (const edge of cycle.edges) {
        const addr = edge.poolAddress.toLowerCase();
        const fail = _failedPools.get(addr);
        if (fail && fail.count >= 2) continue;
        if (!stateCache.has(addr)) {
          missingAddresses.add(addr);
          continue;
        }
        const lastFetched = _lastFetchedAt.get(addr);
        if (lastFetched === undefined || fetchNow - lastFetched >= POOL_STATE_STALE_MS) {
          missingAddresses.add(addr);
        }
      }
    }
  }

  if (missingAddresses.size === 0) return updated;

  const toFetch = Array.from(missingAddresses);
  let missingMeta = 0;
  let batchFailures = 0;

  const BATCH_SIZE = 500;
  const batches: string[][] = [];
  for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
    batches.push(toFetch.slice(i, i + BATCH_SIZE));
  }

  const poolLookup = buildPoolLookup(pools, staticAnchors);

  type MulticallCall = { address: `0x${string}`; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] };
  type V2Reserves = readonly [bigint, bigint, number] | { reserve0: bigint; reserve1: bigint; blockTimestampLast: number };
  type V3Slot0 = readonly [bigint, number, number, number, number, number, boolean] | { sqrtPriceX96: bigint; tick: number };

  const CONCURRENCY_LIMIT = 5;
  for (let i = 0; i < batches.length; i += CONCURRENCY_LIMIT) {
    const chunk = batches.slice(i, i + CONCURRENCY_LIMIT);
    await Promise.all(
      chunk.map(async (batch, j) => {
        const batchIdx = i + j;
        logger?.debug?.(
          { batchIdx: batchIdx + 1, totalBatches: batches.length, count: batch.length },
          "fetchMissingPoolState: starting batch",
        );
        const calls: MulticallCall[] = [];
        for (const addr of batch) {
          const meta = poolLookup.get(addr);
          if (!meta) {
            missingMeta++;
            continue;
          }
          const proto = meta.protocol.toLowerCase();
          if (proto.includes("v2")) {
            calls.push({ address: addr as `0x${string}`, abi: V2_ABI, functionName: "getReserves" });
          } else if (proto.includes("dodo")) {
            calls.push({ address: addr as `0x${string}`, abi: DODO_ABI, functionName: "_BASE_RESERVE_" });
            calls.push({ address: addr as `0x${string}`, abi: DODO_ABI, functionName: "_QUOTE_RESERVE_" });
            calls.push({ address: addr as `0x${string}`, abi: DODO_ABI, functionName: "_R_STATUS_" });
            calls.push({ address: addr as `0x${string}`, abi: DODO_ABI, functionName: "_BASE_TARGET_" });
            calls.push({ address: addr as `0x${string}`, abi: DODO_ABI, functionName: "_QUOTE_TARGET_" });
            const existing = stateCache.get(addr);
            if (!existing || existing.i === undefined || existing.k === undefined) {
              calls.push({ address: addr as `0x${string}`, abi: DODO_ABI, functionName: "_I_" });
              calls.push({ address: addr as `0x${string}`, abi: DODO_ABI, functionName: "_K_" });
              calls.push({ address: addr as `0x${string}`, abi: DODO_ABI, functionName: "_LP_FEE_RATE_" });
              calls.push({ address: addr as `0x${string}`, abi: DODO_ABI, functionName: "_MT_FEE_RATE_" });
            }
          } else if (proto.includes("elastic")) {
            calls.push({ address: addr as `0x${string}`, abi: ELASTIC_ABI, functionName: "getPoolState" });
            calls.push({ address: addr as `0x${string}`, abi: ELASTIC_ABI, functionName: "liquidity" });
            calls.push({ address: meta.token0 as `0x${string}`, abi: ERC20_ABI, functionName: "balanceOf", args: [addr] });
            calls.push({ address: meta.token1 as `0x${string}`, abi: ERC20_ABI, functionName: "balanceOf", args: [addr] });
          } else if (proto.includes("v3")) {
            calls.push({ address: addr as `0x${string}`, abi: V3_ABI, functionName: "slot0" });
            calls.push({ address: addr as `0x${string}`, abi: V3_ABI, functionName: "liquidity" });
            calls.push({ address: meta.token0 as `0x${string}`, abi: ERC20_ABI, functionName: "balanceOf", args: [addr] });
            calls.push({ address: meta.token1 as `0x${string}`, abi: ERC20_ABI, functionName: "balanceOf", args: [addr] });
          } else if (proto.includes("v4")) {
            // V4 PoolMeta.id is bytes32 poolKey — state comes from HyperIndex, not slot0 on the key.
            if (addr.length === 66) continue;
            calls.push({ address: addr as `0x${string}`, abi: V4_ABI, functionName: "slot0" });
            calls.push({ address: addr as `0x${string}`, abi: V4_ABI, functionName: "liquidity" });
            calls.push({ address: addr as `0x${string}`, abi: V4_ABI, functionName: "fee" });
            calls.push({ address: addr as `0x${string}`, abi: V4_ABI, functionName: "tickSpacing" });
            calls.push({ address: addr as `0x${string}`, abi: V4_ABI, functionName: "hooks" });
          } else if (proto.includes("woofi")) {
            calls.push({ address: addr as `0x${string}`, abi: WOOFI_PAIR_ABI, functionName: "price" });
            calls.push({ address: addr as `0x${string}`, abi: WOOFI_PAIR_ABI, functionName: "fee" });
          } else if (proto.includes("balancer")) {
            const cached = stateCache.get(addr) as Record<string, unknown> | undefined;
            const poolId = meta.poolId ?? (cached?.poolId as string | undefined);
            if (poolId) {
              calls.push({
                address: "0xba12222222228d8ba445958a75a0704d566bf2c8",
                abi: VAULT_ABI,
                functionName: "getPoolTokens",
                args: [poolId],
              });
              const existing = stateCache.get(addr);
              if (!existing || existing.swapFee === undefined) {
                calls.push({ address: addr as `0x${string}`, abi: BALANCER_ABI, functionName: "getSwapFeePercentage" });
                calls.push({ address: addr as `0x${string}`, abi: BALANCER_ABI, functionName: "getNormalizedWeights" });
                calls.push({ address: addr as `0x${string}`, abi: BALANCER_ABI, functionName: "getScalingFactors" });
              }
            }
          } else if (proto.includes("curve")) {
            const nCoins = meta.tokens.length;
            for (let idx = 0; idx < nCoins; idx++) {
              calls.push({ address: addr as `0x${string}`, abi: CURVE_ABI, functionName: "balances", args: [BigInt(idx)] });
            }
            const existing = stateCache.get(addr);
            if (!existing || existing.A === undefined) {
              calls.push({ address: addr as `0x${string}`, abi: CURVE_ABI, functionName: "A" });
              calls.push({ address: addr as `0x${string}`, abi: CURVE_ABI, functionName: "fee" });
              for (let idx = 0; idx < nCoins; idx++) {
                calls.push({ address: addr as `0x${string}`, abi: CURVE_ABI, functionName: "rates", args: [BigInt(idx)] });
              }
            }
          }
        }

        if (calls.length === 0) return;

        try {
          const results = await publicClient.multicall({
            // Heterogeneous ABIs per protocol — viem's strict Abi typing can't represent this
            contracts: calls as any,
            allowFailure: true,
          });
          logger?.debug?.({ batchIdx: batchIdx + 1 }, "fetchMissingPoolState: batch results received");

          let resultIdx = 0;
          for (const addr of batch) {
            const meta = poolLookup.get(addr);
            if (!meta) continue;
            const proto = meta.protocol.toLowerCase();

            if (proto.includes("v2")) {
              const res = results[resultIdx++];
              if (res?.status === "success" && res.result) {
                const r = res.result as V2Reserves;
                const rObj = r as { reserve0: bigint; reserve1: bigint };
                const r0 = Array.isArray(r) ? r[0] : rObj.reserve0;
                const r1 = Array.isArray(r) ? r[1] : rObj.reserve1;

                if (r0 !== undefined && r1 !== undefined) {
                  trackSuccessfulPool(
                    addr,
                    stateCache,
                    {
                      reserve0: toBigInt(r0, 0n),
                      reserve1: toBigInt(r1, 0n),
                      fee: meta.fee != null ? BigInt(meta.fee) : 30n,
                      feeDenominator: 10000n,
                      initialized: true,
                    },
                    updated,
                  );
                } else {
                  trackFailedPool(addr, "v2-reserves-undefined", stateCache, logger);
                }
              } else {
                trackFailedPool(addr, "v2-reserves-failed", stateCache, logger);
              }
            } else if (proto.includes("dodo")) {
              const baseRes = results[resultIdx++];
              const quoteRes = results[resultIdx++];
              const rStatusRes = results[resultIdx++];
              const baseTargetRes = results[resultIdx++];
              const quoteTargetRes = results[resultIdx++];

              const existing = stateCache.get(addr);
              const hasStatic = existing && existing.i !== undefined && existing.k !== undefined;

              const iRes = hasStatic ? { status: "success" as const, result: (existing.i ?? existing.I) as bigint } : results[resultIdx++];
              const kRes = hasStatic ? { status: "success" as const, result: (existing.k ?? existing.K) as bigint } : results[resultIdx++];
              const lpFeeRateRes = hasStatic
                ? { status: "success" as const, result: (existing.lpFeeRate ?? existing.feeRate) as bigint }
                : results[resultIdx++];
              const mtFeeRateRes = hasStatic ? { status: "success" as const, result: existing.mtFeeRate as bigint } : results[resultIdx++];

              if (baseRes?.status === "success" && quoteRes?.status === "success" && rStatusRes?.status === "success") {
                trackSuccessfulPool(
                  addr,
                  stateCache,
                  {
                    baseReserve: BigInt(baseRes.result as bigint),
                    quoteReserve: BigInt(quoteRes.result as bigint),
                    rStatus: Number(rStatusRes.result as number),
                    i: iRes?.status === "success" ? BigInt(iRes.result as bigint) : 0n,
                    k: kRes?.status === "success" ? BigInt(kRes.result as bigint) : 0n,
                    baseTarget: baseTargetRes?.status === "success" ? BigInt(baseTargetRes.result as bigint) : 0n,
                    quoteTarget: quoteTargetRes?.status === "success" ? BigInt(quoteTargetRes.result as bigint) : 0n,
                    lpFeeRate: lpFeeRateRes?.status === "success" ? BigInt(lpFeeRateRes.result as bigint) : 0n,
                    mtFeeRate: mtFeeRateRes?.status === "success" ? BigInt(mtFeeRateRes.result as bigint) : 0n,
                    initialized: true,
                  },
                  updated,
                );
              } else {
                trackFailedPool(addr, "dodo-reserves-failed", stateCache, logger);
              }
            } else if (proto.includes("elastic")) {
              const stateRes = results[resultIdx++];
              const liqRes = results[resultIdx++];
              const bal0Res = results[resultIdx++];
              const bal1Res = results[resultIdx++];
              if (stateRes?.status === "success" && stateRes.result && liqRes?.status === "success") {
                const s = stateRes.result as [bigint, number, number, boolean] | { sqrtP: bigint; currentTick: number };
                const sObj = s as { sqrtP: bigint; currentTick: number };
                const sqrtPriceX96 = Array.isArray(s) ? s[0] : sObj.sqrtP;
                const tick = Array.isArray(s) ? s[1] : sObj.currentTick;

                if (sqrtPriceX96 !== undefined && tick !== undefined) {
                  trackSuccessfulPool(
                    addr,
                    stateCache,
                    {
                      sqrtPriceX96: BigInt(sqrtPriceX96),
                      tick: Number(tick),
                      liquidity: BigInt(liqRes.result as bigint),
                      reserve0: bal0Res?.status === "success" ? BigInt(bal0Res.result as bigint) : 0n,
                      reserve1: bal1Res?.status === "success" ? BigInt(bal1Res.result as bigint) : 0n,
                      initialized: true,
                    },
                    updated,
                  );
                } else {
                  trackFailedPool(addr, "elastic-state-undefined", stateCache, logger);
                }
              } else {
                trackFailedPool(addr, "elastic-state-failed", stateCache, logger);
              }
            } else if (proto.includes("v3")) {
              const slot0Res = results[resultIdx++];
              const liqRes = results[resultIdx++];
              const bal0Res = results[resultIdx++];
              const bal1Res = results[resultIdx++];
              if (slot0Res?.status === "success" && slot0Res.result && liqRes?.status === "success") {
                const s = slot0Res.result as V3Slot0;
                const sObj = s as { sqrtPriceX96: bigint; tick: number };
                const sqrtPriceX96 = Array.isArray(s) ? s[0] : sObj.sqrtPriceX96;
                const tick = Array.isArray(s) ? s[1] : sObj.tick;

                if (sqrtPriceX96 !== undefined && tick !== undefined) {
                  trackSuccessfulPool(
                    addr,
                    stateCache,
                    {
                      sqrtPriceX96: BigInt(sqrtPriceX96),
                      tick: Number(tick),
                      liquidity: BigInt(liqRes.result as bigint),
                      token0Balance: bal0Res?.status === "success" ? BigInt(bal0Res.result as bigint) : undefined,
                      token1Balance: bal1Res?.status === "success" ? BigInt(bal1Res.result as bigint) : undefined,
                      initialized: true,
                    },
                    updated,
                  );
                } else {
                  trackFailedPool(addr, "v3-slot0-undefined", stateCache, logger);
                }
              } else {
                const error = slot0Res?.error || liqRes?.error;
                logger?.debug?.({ pool: addr, error }, "V3 fetch failed");
                if ((error as { name?: string })?.name === "ContractFunctionExecutionError") {
                  markAsGarbage(addr).catch((err) => {
                    logger?.warn?.({ err, pool: addr }, "Failed to mark garbage pool");
                  });
                }
                trackFailedPool(addr, "v3-slot0-failed", stateCache, logger);
              }
            } else if (proto.includes("v4")) {
              const slot0Res = results[resultIdx++];
              const liqRes = results[resultIdx++];
              const feeRes = results[resultIdx++];
              const tsRes = results[resultIdx++];
              const hooksRes = results[resultIdx++];
              if (slot0Res?.status === "success" && slot0Res.result && liqRes?.status === "success") {
                const s = slot0Res.result as V3Slot0;
                const sObj = s as { sqrtPriceX96: bigint; tick: number };
                const sqrtPriceX96 = Array.isArray(s) ? s[0] : sObj.sqrtPriceX96;
                const tick = Array.isArray(s) ? s[1] : sObj.tick;

                if (sqrtPriceX96 !== undefined && tick !== undefined) {
                  trackSuccessfulPool(
                    addr,
                    stateCache,
                    {
                      sqrtPriceX96: BigInt(sqrtPriceX96),
                      liquidity: BigInt(liqRes.result as bigint),
                      tick: Number(tick),
                      fee: feeRes?.status === "success" ? BigInt(feeRes.result as bigint) : undefined,
                      tickSpacing: tsRes?.status === "success" ? Number(tsRes.result as bigint) : undefined,
                      hooks: hooksRes?.status === "success" ? (hooksRes.result as string) : undefined,
                      initialized: true,
                    },
                    updated,
                  );
                } else {
                  trackFailedPool(addr, "v4-slot0-undefined", stateCache, logger);
                }
              } else {
                trackFailedPool(addr, "v4-slot0-failed", stateCache, logger);
              }
            } else if (proto.includes("woofi")) {
              const priceRes = results[resultIdx++];
              const feeRes = results[resultIdx++];
              if (priceRes?.status === "success" && priceRes.result) {
                trackSuccessfulPool(
                  addr,
                  stateCache,
                  {
                    price: BigInt(priceRes.result as bigint),
                    fee: feeRes?.status === "success" ? BigInt(feeRes.result as bigint) : undefined,
                    initialized: true,
                  },
                  updated,
                );
              } else {
                trackFailedPool(addr, "woofi-price-failed", stateCache, logger);
              }
            } else if (proto.includes("balancer")) {
              const cached = stateCache.get(addr) as Record<string, unknown> | undefined;
              const poolId = meta.poolId ?? (cached?.poolId as string | undefined);
              if (poolId) {
                const getPoolTokensRes = results[resultIdx++];
                const existing = stateCache.get(addr);
                const hasStatic = existing && existing.swapFee !== undefined;

                const swapFeeRes = hasStatic ? { status: "success" as const, result: existing.swapFee as bigint } : results[resultIdx++];
                const weightsRes = hasStatic ? { status: "success" as const, result: existing.weights as bigint[] } : results[resultIdx++];
                const scalingFactorsRes = hasStatic
                  ? { status: "success" as const, result: existing.scalingFactors as bigint[] }
                  : results[resultIdx++];

                if (getPoolTokensRes?.status === "success" && getPoolTokensRes.result) {
                  const [, balances] = getPoolTokensRes.result as [string[], bigint[]];
                  trackSuccessfulPool(
                    addr,
                    stateCache,
                    {
                      poolId,
                      balances: balances.map(BigInt),
                      weights: weightsRes?.status === "success" ? (weightsRes.result as bigint[]).map(BigInt) : [],
                      amp: existing?.amp as bigint | undefined,
                      swapFee: swapFeeRes?.status === "success" ? BigInt(swapFeeRes.result as bigint) : 0n,
                      scalingFactors: scalingFactorsRes?.status === "success" ? (scalingFactorsRes.result as bigint[]).map(BigInt) : [],
                      initialized: true,
                    },
                    updated,
                  );
                } else {
                  trackFailedPool(addr, "balancer-getPoolTokens-failed", stateCache, logger);
                }
              }
            } else if (proto.includes("curve")) {
              const nCoins = meta.tokens.length;
              const balanceResults = [];
              for (let idx = 0; idx < nCoins; idx++) {
                balanceResults.push(results[resultIdx++]);
              }
              const existing = stateCache.get(addr);
              const hasStatic = existing && existing.A !== undefined;

              const aRes = hasStatic ? { status: "success" as const, result: existing.A as bigint } : results[resultIdx++];
              const feeRes = hasStatic ? { status: "success" as const, result: existing.fee as bigint } : results[resultIdx++];
              const rateResults = [];
              if (!hasStatic) {
                for (let idx = 0; idx < nCoins; idx++) {
                  rateResults.push(results[resultIdx++]);
                }
              }

              const balances = [];
              let success = true;
              for (const r of balanceResults) {
                if (r?.status === "success") {
                  balances.push(BigInt(r.result as bigint));
                } else {
                  success = false;
                }
              }

              if (success) {
                const rates = hasStatic
                  ? (existing.rates as bigint[])
                  : rateResults.map((r) => (r?.status === "success" ? BigInt(r.result as bigint) : null));

                if (!hasStatic && rates.includes(null)) {
                  trackFailedPool(addr, "curve-rates-failed", stateCache, logger);
                } else {
                  trackSuccessfulPool(
                    addr,
                    stateCache,
                    {
                      balances,
                      A: aRes?.status === "success" ? BigInt(aRes.result as bigint) : 100n,
                      fee: feeRes?.status === "success" ? BigInt(feeRes.result as bigint) : 0n,
                      rates: rates as bigint[],
                      initialized: true,
                    },
                    updated,
                  );
                }
              } else {
                trackFailedPool(addr, "curve-balances-failed", stateCache, logger);
              }
            }
          }
        } catch (err) {
          batchFailures++;
          logger?.error?.(
            {
              err,
              batchIdx: batchIdx + 1,
              poolCount: batch.length,
              pools: batch.slice(0, 10), // Log first 10 pools to avoid massive logs
              totalInBatch: batch.length,
            },
            "fetchMissingPoolState: multicall batch failed",
          );
          // Individual pools in this batch are already considered "failed" since they aren't in 'updated'
        }
      }),
    );
  }

  logSampled(
    logger,
    "pool:fetch",
    "debug",
    "Pool state fetch summary",
    {
      requested: toFetch.length,
      updated: updated.size,
      missingMeta,
      batchFailures,
      cacheSize: stateCache.size,
      hitRatePct: toFetch.length > 0 ? Math.round((updated.size / toFetch.length) * 1000) / 10 : 0,
    },
    METRICS_INTERVAL.poolFetch,
  );

  return updated;
}
