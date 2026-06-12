import type { PublicClient } from "viem";
import { TICK_LENS_ABI, TICK_LENS_POLYGON, V3_TICK_READER_ABI } from "../core/abis/compiled/tick_lens.ts";
import { normalizeProtocol } from "../core/utils/protocol.ts";
import type { FoundCycle } from "./types.ts";
import type { PoolMeta } from "../core/types/pool.ts";
import type { RouteStateCache } from "../core/types/route.ts";

export type TickMap = Map<number, { liquidityGross: bigint; liquidityNet: bigint }>;

export interface TickFetchResult {
  ticks: TickMap;
  tickVersion: number;
  loadedWordMin: number;
  loadedWordMax: number;
}

let globalTickVersion = 1;

/** Reset global tick version counter (tests). */
export function resetTickVersionForTests(): void {
  globalTickVersion = 1;
}

function nextTickVersion(): number {
  return globalTickVersion++;
}

function feeToTickSpacing(fee: number | bigint | undefined): number {
  const f = Number(fee ?? 3000);
  if (f <= 100) return 1;
  if (f <= 500) return 10;
  if (f <= 3000) return 60;
  if (f <= 10000) return 200;
  return 60;
}

function isConcentratedProtocol(protocol: string): boolean {
  const p = normalizeProtocol(protocol);
  return p === "V3" || p === "V4" || protocol.toUpperCase().includes("ELASTIC");
}

/** Collect unique V3/V4 pool addresses from cycles. */
export function collectCyclePoolAddresses(cycles: FoundCycle[]): Set<string> {
  const addrs = new Set<string>();
  for (const cycle of cycles) {
    for (const edge of cycle.edges) {
      if (isConcentratedProtocol(edge.protocol)) {
        addrs.add(edge.poolAddress.toLowerCase());
      }
    }
  }
  return addrs;
}

type PopulatedTick = { tick: number; liquidityNet: bigint };

/**
 * Fetch initialized ticks around currentTick via TickLens multicall.
 */
export async function fetchPoolTicks(
  client: PublicClient,
  poolAddr: string,
  currentTick: number,
  tickSpacing: number,
  wordRange: number = 3,
  tickLensAddress: `0x${string}` = TICK_LENS_POLYGON,
): Promise<TickFetchResult | null> {
  if (!Number.isFinite(currentTick)) return null;

  const centerWord = currentTick >> 8;
  const words: number[] = [];
  for (let w = centerWord - wordRange; w <= centerWord + wordRange; w++) {
    words.push(w);
  }

  const calls = words.map((word) => ({
    address: tickLensAddress,
    abi: TICK_LENS_ABI,
    functionName: "getPopulatedTicksInWord" as const,
    args: [poolAddr as `0x${string}`, word as number] as const,
  }));

  let results: Awaited<ReturnType<PublicClient["multicall"]>>;
  try {
    results = await client.multicall({ contracts: calls as any, allowFailure: true });
  } catch {
    return null;
  }

  const ticks: TickMap = new Map();
  for (const res of results) {
    if (res.status !== "success" || !res.result) continue;
    const populated = res.result as PopulatedTick[];
    for (const pt of populated) {
      const tick = Number(pt.tick);
      const liquidityNet = typeof pt.liquidityNet === "bigint" ? pt.liquidityNet : BigInt(pt.liquidityNet);
      ticks.set(tick, {
        liquidityGross: liquidityNet < 0n ? -liquidityNet : liquidityNet,
        liquidityNet,
      });
    }
  }

  if (ticks.size === 0) return null;

  return {
    ticks,
    tickVersion: nextTickVersion(),
    loadedWordMin: centerWord - wordRange,
    loadedWordMax: centerWord + wordRange,
  };
}

function tickMovedOutsideRange(currentTick: number, loadedWordMin?: number, loadedWordMax?: number): boolean {
  if (loadedWordMin == null || loadedWordMax == null) return true;
  const word = currentTick >> 8;
  return word < loadedWordMin || word > loadedWordMax;
}

/**
 * Refresh tick data for cycle pools into stateCache (throttled).
 */
export async function fetchTicksForCyclePools(
  client: PublicClient,
  stateCache: RouteStateCache,
  cycles: FoundCycle[],
  pools: PoolMeta[],
  options: {
    wordRange?: number;
    refreshOnMove?: boolean;
    tickLensAddress?: `0x${string}`;
  } = {},
): Promise<number> {
  const wordRange = options.wordRange ?? 3;
  const refreshOnMove = options.refreshOnMove ?? true;
  const poolLookup = new Map(pools.map((p) => [p.address.toLowerCase(), p]));
  const addrs = collectCyclePoolAddresses(cycles);
  let updated = 0;

  for (const addr of addrs) {
    const state = stateCache.get(addr);
    if (!state) continue;

    const tick = Number(state.tick);
    if (!Number.isFinite(tick)) continue;

    const meta = poolLookup.get(addr);
    const tickSpacing = Number(state.tickSpacing ?? meta?.fee != null ? feeToTickSpacing(meta.fee) : 60);
    const loadedMin = state.loadedWordMin as number | undefined;
    const loadedMax = state.loadedWordMax as number | undefined;

    if (
      refreshOnMove &&
      state.ticks instanceof Map &&
      state.ticks.size > 0 &&
      !tickMovedOutsideRange(tick, loadedMin, loadedMax)
    ) {
      continue;
    }

    const result = await fetchPoolTicks(client, addr, tick, tickSpacing, wordRange, options.tickLensAddress);
    if (!result) continue;

    stateCache.set(addr, {
      ...state,
      ticks: result.ticks,
      tickVersion: result.tickVersion,
      tickSpacing,
      loadedWordMin: result.loadedWordMin,
      loadedWordMax: result.loadedWordMax,
    });
    updated++;
  }

  return updated;
}

/** Widen tick word range when simulation hits loaded tick boundary. */
export async function widenPoolTicks(
  client: PublicClient,
  stateCache: RouteStateCache,
  poolAddr: string,
  pools: PoolMeta[],
  extraWordRange: number = 3,
): Promise<boolean> {
  const state = stateCache.get(poolAddr.toLowerCase());
  if (!state) return false;
  const tick = Number(state.tick);
  if (!Number.isFinite(tick)) return false;
  const meta = pools.find((p) => p.address.toLowerCase() === poolAddr.toLowerCase());
  const tickSpacing = Number(state.tickSpacing ?? meta?.fee != null ? feeToTickSpacing(meta.fee) : 60);
  const baseRange = Number(state.loadedWordMax ?? 0) - Number(state.loadedWordMin ?? 0);
  const wordRange = Math.max(3, Math.floor(baseRange / 2) + extraWordRange);
  const result = await fetchPoolTicks(client, poolAddr, tick, tickSpacing, wordRange);
  if (!result) return false;
  stateCache.set(poolAddr.toLowerCase(), {
    ...state,
    ticks: result.ticks,
    tickVersion: result.tickVersion,
    tickSpacing,
    loadedWordMin: result.loadedWordMin,
    loadedWordMax: result.loadedWordMax,
  });
  return true;
}
