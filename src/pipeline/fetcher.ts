import { parseAbi } from "viem";
import type { PublicClient } from "viem";
import { toBigInt } from "../core/utils/bigint.ts";
import { INVALID_POOL_STATE } from "../core/types/pool.ts";
import type { PoolMeta } from "../core/types/pool.ts";
import type { FoundCycle } from "./types.ts";
import { STATIC_ANCHORS } from "../infra/hypersync/hyperindex_graphql.ts";
import type { HyperSyncService } from "../infra/hypersync/hypersync_service.ts";

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

const _failedPools = new Map<string, { count: number; lastTry: number }>();
const FAILED_POOLS_MAX_SIZE = 10_000;
const FAILED_POOLS_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

export function getFailedPools(): Map<string, { count: number; lastTry: number }> {
  return _failedPools;
}

export function pruneFailedPools(now: number = Date.now()): void {
  if (_failedPools.size <= FAILED_POOLS_MAX_SIZE) {
    // Age-based eviction for old entries even if under cap
    for (const [addr, entry] of _failedPools) {
      if (now - entry.lastTry > FAILED_POOLS_MAX_AGE_MS) {
        _failedPools.delete(addr);
      }
    }
    return;
  }
  // Over cap: evict oldest first (simple, no extra structures)
  const entries = Array.from(_failedPools.entries()).sort((a, b) => a[1].lastTry - b[1].lastTry);
  const toEvict = entries.length - Math.floor(FAILED_POOLS_MAX_SIZE * 0.9);
  for (let i = 0; i < toEvict && i < entries.length; i++) {
    _failedPools.delete(entries[i][0]);
  }
}

export async function fetchMissingPoolState(
  publicClient: PublicClient,
  stateCache: Map<string, Record<string, unknown>>,
  pools: PoolMeta[],
  currentCycles: FoundCycle[],
  forceRefresh: boolean = false,
  _hyperSync?: HyperSyncService,
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
    for (const anchor of STATIC_ANCHORS) {
      missingAddresses.add(anchor.address.toLowerCase());
    }
  } else {
    for (const anchor of STATIC_ANCHORS) {
      const addr = anchor.address.toLowerCase();
      if (!stateCache.has(addr)) {
        missingAddresses.add(addr);
      }
    }

    for (const cycle of currentCycles) {
      for (const edge of cycle.edges) {
        const addr = edge.poolAddress.toLowerCase();
        if (!stateCache.has(addr)) {
          const fail = _failedPools.get(addr);
          if (fail && fail.count > 3 && now - fail.lastTry < 300_000) continue;
          missingAddresses.add(addr);
        }
      }
    }
  }

  if (missingAddresses.size === 0) return updated;

  // HyperSync logs pre-fetch path removed: it was a no-op stub that populated
  // { initialized: false, fromHyperSyncLogs: true } placeholders, causing the
  // subsequent multicall to do wasted work (and potentially confusing simulators
  // that saw uninitialized state). All state is now fetched via the reliable
  // multicall batch path below.

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

  // Use a minimal shape compatible with viem multicall. The actual ABIs (from parseAbi) are precise.
  type MulticallCall = { address: `0x${string}`; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] };

  await Promise.all(
    batches.map(async (batch) => {
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
        }
      }

      if (calls.length === 0) return;

      try {
        const results = await publicClient.multicall({
          // The per-protocol ABIs + function selection above guarantee shape correctness;
          // the cast is only to satisfy viem's precise Abi typing for heterogeneous batches.
          contracts: calls as any,
          allowFailure: true,
        });

        let resultIdx = 0;
        for (const addr of batch) {
          const meta = poolLookup.get(addr);
          if (!meta) continue;
          const proto = meta.protocol.toLowerCase();

          if (proto.includes("v2") || proto.includes("dodo")) {
            const res = results[resultIdx++];
            if (res?.status === "success" && res.result) {
              const r = res.result as Record<string, unknown> | unknown[];
              const r0 = Array.isArray(r) ? r[0] : (r as any).reserve0;
              const r1 = Array.isArray(r) ? r[1] : (r as any).reserve1;

              if (r0 !== undefined && r1 !== undefined) {
                stateCache.set(addr, {
                  reserve0: toBigInt(r0, 0n),
                  reserve1: toBigInt(r1, 0n),
                  initialized: true,
                });
                updated.add(addr);
                _failedPools.delete(addr);
              } else {
                const fail = _failedPools.get(addr) || { count: 0, lastTry: 0 };
                _failedPools.set(addr, { count: fail.count + 1, lastTry: now });
                if (fail.count >= 1) {
                  stateCache.set(addr, INVALID_POOL_STATE);
                }
              }
            } else {
              const fail = _failedPools.get(addr) || { count: 0, lastTry: 0 };
              _failedPools.set(addr, { count: fail.count + 1, lastTry: now });
              if (fail.count >= 1) {
                stateCache.set(addr, INVALID_POOL_STATE);
              }
            }
          } else if (proto.includes("v3") || proto.includes("elastic")) {
            const slot0Res = results[resultIdx++];
            const liqRes = results[resultIdx++];
            if (slot0Res?.status === "success" && slot0Res.result && liqRes?.status === "success") {
              const s = slot0Res.result as any;
              const sqrtPriceX96 = s[0] !== undefined ? s[0] : s.sqrtPriceX96;
              const tick = s[1] !== undefined ? s[1] : s.tick;

              if (sqrtPriceX96 !== undefined && tick !== undefined) {
                stateCache.set(addr, {
                  sqrtPriceX96: BigInt(sqrtPriceX96),
                  tick: Number(tick),
                  liquidity: BigInt(liqRes.result as any),
                  initialized: true,
                });
                updated.add(addr);
                _failedPools.delete(addr);
              } else {
                const fail = _failedPools.get(addr) || { count: 0, lastTry: 0 };
                _failedPools.set(addr, { count: fail.count + 1, lastTry: now });
                if (fail.count >= 1) {
                  stateCache.set(addr, INVALID_POOL_STATE);
                }
              }
            } else {
              const fail = _failedPools.get(addr) || { count: 0, lastTry: 0 };
              _failedPools.set(addr, { count: fail.count + 1, lastTry: now });
              if (fail.count >= 1) {
                stateCache.set(addr, INVALID_POOL_STATE);
              }
            }
          } else if (proto.includes("v4")) {
            const slot0Res = results[resultIdx++];
            const liqRes = results[resultIdx++];
            const feeRes = results[resultIdx++];
            const tsRes = results[resultIdx++];
            const hooksRes = results[resultIdx++];
            if (slot0Res?.status === "success" && slot0Res.result && liqRes?.status === "success") {
              const s = slot0Res.result as any;
              const sqrtPriceX96 = s[0] !== undefined ? s[0] : s.sqrtPriceX96;
              const tick = s[1] !== undefined ? s[1] : s.tick;

              if (sqrtPriceX96 !== undefined && tick !== undefined) {
                stateCache.set(addr, {
                  sqrtPriceX96: BigInt(sqrtPriceX96),
                  liquidity: BigInt(liqRes.result as any),
                  tick: Number(tick),
                  fee: feeRes?.status === "success" ? BigInt(feeRes.result as any) : undefined,
                  tickSpacing: tsRes?.status === "success" ? Number(tsRes.result as any) : undefined,
                  hooks: hooksRes?.status === "success" ? (hooksRes.result as any) : undefined,
                  initialized: true,
                });
                updated.add(addr);
                _failedPools.delete(addr);
              } else {
                const fail = _failedPools.get(addr) || { count: 0, lastTry: 0 };
                _failedPools.set(addr, { count: fail.count + 1, lastTry: now });
                if (fail.count >= 1) {
                  stateCache.set(addr, INVALID_POOL_STATE);
                }
              }
            } else {
              const fail = _failedPools.get(addr) || { count: 0, lastTry: 0 };
              _failedPools.set(addr, { count: fail.count + 1, lastTry: now });
              if (fail.count >= 1) {
                stateCache.set(addr, INVALID_POOL_STATE);
              }
            }
          } else if (proto.includes("woofi")) {
            const priceRes = results[resultIdx++];
            const feeRes = results[resultIdx++];
            if (priceRes?.status === "success" && priceRes.result) {
              stateCache.set(addr, {
                price: BigInt(priceRes.result as any),
                fee: feeRes?.status === "success" ? BigInt(feeRes.result as any) : undefined,
                initialized: true,
              });
              updated.add(addr);
              _failedPools.delete(addr);
            } else {
              const fail = _failedPools.get(addr) || { count: 0, lastTry: 0 };
              _failedPools.set(addr, { count: fail.count + 1, lastTry: now });
              if (fail.count >= 1) {
                stateCache.set(addr, INVALID_POOL_STATE);
              }
            }
          }
        }
      } catch {
        // Ignore individual batch failures
      }
    }),
  );

  return updated;
}
