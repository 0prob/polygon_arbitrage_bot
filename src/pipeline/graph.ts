import type { Address } from "../core/types/common.ts";
import type { PoolMeta, PoolState } from "../core/types/pool.ts";
import type { SwapEdge, RoutingGraph } from "./types.ts";
import { DEFAULT_FEE_BPS } from "./types.ts";
import { isGarbagePool } from "../infra/garbage/garbage-tracker.ts";
import { isInvalidState } from "../core/types/pool.ts";
import { normalizeProtocol } from "../core/utils/protocol.ts";
import { tokensToMaticWei } from "../core/assessment/profit.ts";
import { BoundedMap } from "../core/utils/bounded_map.ts";
import { normalizePoolAddress, normalizeAddress } from "../core/utils/normalize.ts";
import type { RouteStateCache } from "../core/types/route.ts";
import { toBigInt } from "../core/utils/bigint.ts";

export interface FilterPoolsForRoutingOptions {
  minLiquidityV3: bigint;
}

export interface FilterPoolsForRoutingResult {
  filtered: PoolMeta[];
  filteredFeeZero: number;
  filteredGarbage: number;
  filteredV3NoState: number;
  filteredV3LowLiq: number;
}

/** Single-pass pool filter before graph build / cycle enumeration. */
export function filterPoolsForRouting(
  pools: PoolMeta[],
  stateCache: RouteStateCache,
  options: FilterPoolsForRoutingOptions,
): FilterPoolsForRoutingResult {
  let filteredFeeZero = 0;
  let filteredGarbage = 0;
  let filteredV3NoState = 0;
  let filteredV3LowLiq = 0;

  const filtered = pools.filter((p) => {
    const protocol = p.protocol.toLowerCase();
    if (p.fee === 0) {
      const feeInState = protocol.includes("balancer") || protocol.includes("curve") || protocol.includes("woofi");
      if (!feeInState) {
        filteredFeeZero++;
        return false;
      }
    }
    if (isGarbagePool(p)) {
      filteredGarbage++;
      return false;
    }
    const addr = normalizePoolAddress(p.address);
    if (protocol.includes("v3") || protocol.includes("v4") || protocol.includes("elastic")) {
      const poolState = stateCache.get(addr);
      if (!poolState) {
        filteredV3NoState++;
      } else {
        const rawLiq = (poolState as Record<string, unknown>).liquidity ?? 0;
        const liq = toBigInt(rawLiq, 0n);
        if (liq < options.minLiquidityV3) {
          filteredV3LowLiq++;
          return false;
        }
      }
    }
    return true;
  });

  return { filtered, filteredFeeZero, filteredGarbage, filteredV3NoState, filteredV3LowLiq };
}

/**
 * Creates the bidirectional SwapEdge entries for a single pool.
 * Shared by buildGraph (full) and IncrementalGraphUpdater.addNewPool to avoid
 * duplicated edge-generation logic (and risk of drift in zeroForOne/idx/fee handling).
 */
export function createEdgesForPool(pool: PoolMeta, state: Record<string, unknown> | undefined): SwapEdge[] {
  const edges: SwapEdge[] = [];
  const addr = normalizePoolAddress(pool.address) as Address;
  const t = pool.tokens ?? [];
  const feeBps = pool.fee != null ? BigInt(pool.fee) : DEFAULT_FEE_BPS;
  for (let i = 0; i < t.length; i++) {
    const tILower = normalizeAddress(t[i]) as Address;
    for (let j = 0; j < t.length; j++) {
      if (i === j) continue;
      const tJLower = normalizeAddress(t[j]) as Address;
      edges.push({
        poolAddress: addr,
        protocol: pool.protocol,
        tokenIn: tILower,
        tokenOut: tJLower,
        feeBps,
        stateRef: state,
        zeroForOne: i < j,
        tokenInIdx: i,
        tokenOutIdx: j,
      });
    }
  }
  return edges;
}

const edgesCache = new BoundedMap<string, SwapEdge[]>({ maxSize: 10_000, ttlMs: 600_000 });

export function buildGraph(
  pools: PoolMeta[],
  stateCache: { get(key: string, now?: number): unknown; has(key: string, now?: number): boolean },
  tokenToMaticRates?: Map<string, bigint>,
  liquidityFloorUsd?: number,
): RoutingGraph {
  const cleanPools = pools.filter((p) => !isGarbagePool(p));

  const adjacency = new Map<string, SwapEdge[]>();
  const poolMeta = new Map<string, PoolMeta>();
  const stateRefs = new Map<string, PoolState | null>();
  const tokens = new Set<string>();

  const maticPerUsd = 2n;

  const now = Date.now();
  for (let i = 0; i < cleanPools.length; i++) {
    const pool = cleanPools[i];
    const addr = normalizePoolAddress(pool.address);
    const state = stateCache.get(addr, now) as Record<string, unknown> | undefined;

    if (state && !isInvalidState(state) && tokenToMaticRates && liquidityFloorUsd != null && liquidityFloorUsd > 0) {
      const proto = normalizeProtocol(pool.protocol);
      if (proto === "V2") {
        const r0 = state.reserve0 as bigint | undefined;
        const r1 = state.reserve1 as bigint | undefined;
        const rate0 = tokenToMaticRates.get(normalizeAddress(pool.token0));
        const rate1 = tokenToMaticRates.get(normalizeAddress(pool.token1));
        let poolLiquidityMatic = 0n;
        if (r0 != null && rate0 != null) poolLiquidityMatic += tokensToMaticWei(r0, rate0);
        if (r1 != null && rate1 != null) poolLiquidityMatic += tokensToMaticWei(r1, rate1);
        const floorMatic = BigInt(Math.floor(liquidityFloorUsd)) * maticPerUsd * 10n ** 18n;
        if (poolLiquidityMatic > 0n && poolLiquidityMatic < floorMatic) continue;
      }
    }

    poolMeta.set(addr, pool);
    stateRefs.set(addr, (state as PoolState) ?? null);
    
    const t = pool.tokens ?? [];
    for (let i = 0; i < t.length; i++) {
      tokens.add(normalizeAddress(t[i]));
    }

    let poolEdges = edgesCache.get(addr, now);
    const expectedEdgeCount = t.length * (t.length - 1);
    if (poolEdges && poolEdges.length !== expectedEdgeCount) {
      poolEdges = undefined;
    }
    if (!poolEdges) {
      poolEdges = createEdgesForPool(pool, state);
      edgesCache.set(addr, poolEdges, now);
    } else {
      for (let i = 0; i < poolEdges.length; i++) {
        poolEdges[i].stateRef = state;
      }
    }

    for (let eIdx = 0; eIdx < poolEdges.length; eIdx++) {
      const edge = poolEdges[eIdx];
      const from = edge.tokenIn;
      let adj = adjacency.get(from);
      if (!adj) {
        adj = [];
        adjacency.set(from, adj);
      }
      adj.push(edge);
    }
  }
  return { adjacency, poolMeta, stateRefs, tokens };
}

/** Clear edge LRU cache (vitest isolation). */
export function resetGraphCacheForTests(): void {
  edgesCache.clear();
}
