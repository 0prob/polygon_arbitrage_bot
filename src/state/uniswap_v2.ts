/**
 * src/state/uniswap_v2.ts — Uniswap V2 / QuickSwap / SushiSwap pool state fetcher
 *
 * Fetches getReserves() for constant-product AMM pools.
 * Uses retry/backoff and concurrency throttling.
 */

import { chunk } from "../utils/concurrency.ts";
import { isNoDataReadContractError, multicallWithRetry, readContractWithRetry, throttledMap } from "../state/enrichment/rpc.ts";
import { ENRICH_CONCURRENCY, V2_RESERVES_MULTICALL_CHUNK_SIZE } from "../config/index.ts";
import { stateMulticallWithFallback, V2_GET_RESERVES_ABI, type StateReadBlockTag } from "./state_multicall_hydrator.ts";

// ─── ABI fragment ─────────────────────────────────────────────

const GET_RESERVES_ABI = V2_GET_RESERVES_ABI;

type V2ReserveFetchDeps = {
  multicall?: typeof multicallWithRetry;
};

export type V2FetchOptions = {
  blockTag?: StateReadBlockTag;
};

export type V2PoolState = {
  address: string;
  reserve0: bigint;
  reserve1: bigint;
  blockTimestampLast: number;
  fetchedAt: number;
};

export type V2StateMap = Map<string, V2PoolState> & {
  noDataFailures?: Set<string>;
};

type V2MulticallResult = {
  status?: unknown;
  result?: unknown;
  error?: unknown;
};

type V2Numberish = string | number | bigint | boolean;
type V2ReservesResult = readonly [V2Numberish, V2Numberish, V2Numberish, ...unknown[]];

function normalizeV2PoolAddress(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeV2MulticallResult(poolAddress: string, result: V2MulticallResult | null | undefined): V2PoolState | null {
  if (!result || result.status !== "success") return null;
  const reserves = result.result;
  if (!Array.isArray(reserves) || reserves.length < 3) return null;
  try {
    const reserve0 = BigInt(reserves[0]);
    const reserve1 = BigInt(reserves[1]);
    const blockTimestampLast = Number(reserves[2]);
    if (!Number.isFinite(blockTimestampLast)) return null;
    return {
      address: poolAddress,
      reserve0,
      reserve1,
      blockTimestampLast,
      fetchedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

// ─── Core State Fetcher ───────────────────────────────────────

/**
 * Fetch reserves for a single V2 pool.
 *
 * @param {string} poolAddress  Checksummed pair address
 * @returns {Promise<V2PoolState>}
 *
 * @typedef {Object} V2PoolState
 * @property {string}  address    Pool address
 * @property {bigint}  reserve0   Reserve of token0
 * @property {bigint}  reserve1   Reserve of token1
 * @property {number}  fetchedAt  Timestamp of fetch (ms)
 */
export async function fetchV2PoolState(poolAddress: string, options: V2FetchOptions = {}): Promise<V2PoolState> {
  const result = await readContractWithRetry<V2ReservesResult>({
    address: poolAddress,
    abi: GET_RESERVES_ABI,
    functionName: "getReserves",
    blockTag: options.blockTag,
  });

  return {
    address: poolAddress,
    reserve0: BigInt(result[0]),
    reserve1: BigInt(result[1]),
    blockTimestampLast: Number(result[2]),
    fetchedAt: Date.now(),
  };
}

/**
 * Fetch state for multiple V2 pools in parallel.
 *
 * @param {string[]} poolAddresses  Array of pair addresses
 * @param {number} [concurrency]    Max parallel fetches
 * @returns {Promise<Map<string, V2PoolState>>}
 */
export async function fetchMultipleV2States(
  poolAddresses: string[],
  concurrency = ENRICH_CONCURRENCY,
  options: V2FetchOptions = {},
): Promise<V2StateMap> {
  return fetchMultipleV2StatesWithDeps(poolAddresses, concurrency, {}, options);
}

export async function fetchMultipleV2StatesWithDeps(
  poolAddresses: string[],
  concurrency = ENRICH_CONCURRENCY,
  deps: V2ReserveFetchDeps = {},
  options: V2FetchOptions = {},
): Promise<V2StateMap> {
  const states: V2StateMap = new Map();
  const noDataFailures = new Set<string>();
  const addresses = Array.isArray(poolAddresses) ? [...new Set(poolAddresses.map(normalizeV2PoolAddress).filter(Boolean))] : [];
  if (addresses.length === 0) {
    states.noDataFailures = noDataFailures;
    return states;
  }

  const multicall = (deps.multicall ?? stateMulticallWithFallback) as (params: Record<string, unknown>) => Promise<unknown>;
  const chunkSize = Math.max(1, Math.floor(V2_RESERVES_MULTICALL_CHUNK_SIZE));
  const batches = chunk(addresses, chunkSize);
  const batchConcurrency = Math.max(1, Math.min(Math.floor(Number(concurrency) || 1), 3, batches.length));
  let failedCalls = 0;
  let failedBatches = 0;

  await throttledMap(
    batches,
    async (batch) => {
      const contracts = batch.map((addr) => ({
        address: addr as `0x${string}`,
        abi: GET_RESERVES_ABI,
        functionName: "getReserves",
      }));

      let results: V2MulticallResult[];
      try {
        results = (await multicall({
          contracts,
          allowFailure: true,
          blockTag: options.blockTag,
        })) as V2MulticallResult[];
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        failedBatches++;
        failedCalls += batch.length;
        console.warn(`  Failed to fetch V2 reserve multicall batch (${batch.length} pools): ${message}`);
        return;
      }

      for (let i = 0; i < batch.length; i++) {
        const addr = batch[i];
        const result = results[i];
        const state = normalizeV2MulticallResult(addr, result);
        if (state) {
          states.set(addr, state);
          continue;
        }

        failedCalls++;
        if (isNoDataReadContractError(result?.error)) {
          noDataFailures.add(addr);
        }
      }
    },
    batchConcurrency,
  );

  if (failedCalls > 0) {
    console.warn(
      `  Failed to fetch V2 reserves for ${failedCalls}/${addresses.length} pool(s)` +
        (failedBatches > 0 ? ` across ${failedBatches} failed multicall batch(es).` : "."),
    );
  }

  states.noDataFailures = noDataFailures;
  return states;
}
