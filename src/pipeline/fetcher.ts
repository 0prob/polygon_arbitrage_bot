import { parseAbi } from "viem";
import type { PublicClient } from "viem";
import { toBigInt } from "../core/utils/bigint.ts";
import { INVALID_POOL_STATE } from "../core/types/pool.ts";
import type { PoolMeta } from "../core/types/pool.ts";
import type { FoundCycle } from "./types.ts";
import { markAsGarbage } from "../infra/garbage/garbage-tracker.ts";

const V2_ABI = parseAbi(["function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)"]);
const V3_ABI = parseAbi([
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
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

const _failedPools = new Map<string, { count: number; lastTry: number }>();
const FAILED_POOLS_MAX_SIZE = 10_000;
const FAILED_POOLS_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

export function getFailedPools(): Map<string, { count: number; lastTry: number }> {
  return _failedPools;
}

export function pruneFailedPools(now: number = Date.now()): void {
  if (_failedPools.size <= FAILED_POOLS_MAX_SIZE) {
    for (const [addr, entry] of _failedPools) {
      if (now - entry.lastTry > FAILED_POOLS_MAX_AGE_MS) {
        _failedPools.delete(addr);
      }
    }
    return;
  }
  const entries = Array.from(_failedPools.entries()).sort((a, b) => a[1].lastTry - b[1].lastTry);
  const toEvict = entries.length - Math.floor(FAILED_POOLS_MAX_SIZE * 0.9);
  for (let i = 0; i < toEvict && i < entries.length; i++) {
    _failedPools.delete(entries[i][0]);
  }
}

function trackFailedPool(addr: string, reason: string, stateCache: Map<string, Record<string, unknown>>, now: number): void {
  const fail = _failedPools.get(addr) || { count: 0, lastTry: 0 };
  const newCount = fail.count + 1;
  _failedPools.set(addr, { count: newCount, lastTry: now });

  // Only mark as invalid if it fails 3 times in a row
  if (newCount >= 3) {
    if (newCount === 3) {
      console.debug(`[fetcher] Marking pool ${addr} as INVALID after 3 failures (Reason: ${reason})`);
    }
    stateCache.set(addr, INVALID_POOL_STATE);
  }
}

function trackSuccessfulPool(
  addr: string,
  stateCache: Map<string, Record<string, unknown>>,
  state: Record<string, unknown>,
  updated: Set<string>,
): void {
  stateCache.set(addr, state);
  updated.add(addr);
  _failedPools.delete(addr);
}

export async function fetchMissingPoolState(
  publicClient: PublicClient,
  stateCache: Map<string, Record<string, unknown>>,
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
  const now = Date.now();

  // Periodic bounded pruning prevents unbounded growth on flaky RPC/indexer (was a memory leak)
  if (Math.random() < 0.05 || _failedPools.size > 1000) {
    pruneFailedPools(now);
  }

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
        if (fail && fail.count >= 2 && now - fail.lastTry < 300_000) continue;
        missingAddresses.add(addr); // always (re)fetch for cycles to keep state fresh for sims (V* states not updated by indexer)
      }
    }
  }

  if (missingAddresses.size === 0) return updated;

  const toFetch = Array.from(missingAddresses);

  const BATCH_SIZE = 500;
  const batches: string[][] = [];
  for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
    batches.push(toFetch.slice(i, i + BATCH_SIZE));
  }

  const poolLookup = new Map<string, PoolMeta>();
  for (const p of pools) {
    poolLookup.set(p.address.toLowerCase(), p);
  }
  for (const anchor of staticAnchors) {
    const addr = anchor.address.toLowerCase();
    if (!poolLookup.has(addr)) {
      poolLookup.set(addr, anchor as PoolMeta);
    }
  }

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
          if (!meta) continue;
          const proto = meta.protocol.toLowerCase();
          if (proto.includes("v2") || proto.includes("dodo")) {
            calls.push({ address: addr as `0x${string}`, abi: V2_ABI, functionName: "getReserves" });
          } else if (proto.includes("v3") || proto.includes("elastic")) {
            calls.push({ address: addr as `0x${string}`, abi: V3_ABI, functionName: "slot0" });
            calls.push({ address: addr as `0x${string}`, abi: V3_ABI, functionName: "liquidity" });
          } else if (proto.includes("v4")) {
            calls.push({ address: addr as `0x${string}`, abi: V4_ABI, functionName: "slot0" });
            calls.push({ address: addr as `0x${string}`, abi: V4_ABI, functionName: "liquidity" });
            calls.push({ address: addr as `0x${string}`, abi: V4_ABI, functionName: "fee" });
            calls.push({ address: addr as `0x${string}`, abi: V4_ABI, functionName: "tickSpacing" });
            calls.push({ address: addr as `0x${string}`, abi: V4_ABI, functionName: "hooks" });
          } else if (proto.includes("woofi")) {
            calls.push({ address: addr as `0x${string}`, abi: WOOFI_PAIR_ABI, functionName: "price" });
            calls.push({ address: addr as `0x${string}`, abi: WOOFI_PAIR_ABI, functionName: "fee" });
          } else if (proto.includes("balancer")) {
            const poolId = (meta as any).poolId;
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

            if (proto.includes("v2") || proto.includes("dodo")) {
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
                      initialized: true,
                    },
                    updated,
                  );
                } else {
                  trackFailedPool(addr, "v2-reserves-undefined", stateCache, now);
                }
              } else {
                trackFailedPool(addr, "v2-reserves-failed", stateCache, now);
              }
            } else if (proto.includes("v3") || proto.includes("elastic")) {
              const slot0Res = results[resultIdx++];
              const liqRes = results[resultIdx++];
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
                      initialized: true,
                    },
                    updated,
                  );
                } else {
                  trackFailedPool(addr, "v3-slot0-undefined", stateCache, now);
                }
              } else {
                const error = slot0Res?.error || liqRes?.error;
                console.debug(`[fetcher] V3 fetch failed for ${addr}: ${JSON.stringify(error)}`);
                if ((error as any)?.name === "ContractFunctionExecutionError") {
                  markAsGarbage(addr).catch(() => {});
                }
                trackFailedPool(addr, "v3-slot0-failed", stateCache, now);
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
                  trackFailedPool(addr, "v4-slot0-undefined", stateCache, now);
                }
              } else {
                trackFailedPool(addr, "v4-slot0-failed", stateCache, now);
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
                trackFailedPool(addr, "woofi-price-failed", stateCache, now);
              }
            } else if (proto.includes("balancer")) {
              const poolId = (meta as any).poolId;
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
                  trackFailedPool(addr, "balancer-getPoolTokens-failed", stateCache, now);
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
                  : rateResults.map((r) => (r?.status === "success" ? BigInt(r.result as bigint) : 10n ** 18n));

                trackSuccessfulPool(
                  addr,
                  stateCache,
                  {
                    balances,
                    A: aRes?.status === "success" ? BigInt(aRes.result as bigint) : 100n,
                    fee: feeRes?.status === "success" ? BigInt(feeRes.result as bigint) : 0n,
                    rates,
                    initialized: true,
                  },
                  updated,
                );
              } else {
                trackFailedPool(addr, "curve-balances-failed", stateCache, now);
              }
            }
          }
        } catch (err) {
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

  return updated;
}
