import type { Address } from "../core/types/common.ts";
import type { PoolMeta, PoolState } from "../core/types/pool.ts";
import type { SwapEdge, RoutingGraph } from "./types.ts";
import { DEFAULT_FEE_BPS } from "./types.ts";
import { isGarbagePool } from "../infra/garbage/garbage-tracker.ts";
import { isInvalidState } from "../core/types/pool.ts";
import { normalizeProtocol } from "./simulator.ts";
import { tokensToMaticWei } from "../core/assessment/profit.ts";

/**
 * Creates the bidirectional SwapEdge entries for a single pool.
 * Shared by buildGraph (full) and IncrementalGraphUpdater.addNewPool to avoid
 * duplicated edge-generation logic (and risk of drift in zeroForOne/idx/fee handling).
 */
export function createEdgesForPool(pool: PoolMeta, state: Record<string, unknown> | undefined): SwapEdge[] {
  const edges: SwapEdge[] = [];
  const addr = pool.address.toLowerCase() as Address;
  const t = pool.tokens ?? [];
  const feeBps = pool.fee != null ? BigInt(pool.fee) : DEFAULT_FEE_BPS;
  for (let i = 0; i < t.length; i++) {
    const tILower = t[i].toLowerCase() as Address;
    for (let j = 0; j < t.length; j++) {
      if (i === j) continue;
      const tJLower = t[j].toLowerCase() as Address;
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

export function buildGraph(
  pools: PoolMeta[],
  stateCache: Map<string, unknown>,
  tokenToMaticRates?: Map<string, bigint>,
  liquidityFloorUsd?: number,
): RoutingGraph {
  // Final safety net: drop any garbage pools that somehow made it this far
  // (e.g. historical data from before the indexer filter, or bad static anchors).
  const cleanPools = pools.filter((p) => !isGarbagePool(p));

  const adjacency = new Map<string, SwapEdge[]>();
  const poolMeta = new Map<string, PoolMeta>();
  const stateRefs = new Map<string, PoolState | null>();
  const tokens = new Set<string>();

  // Use a rough MATIC price for liquidity filtering if rates provided.
  // 1 MATIC ~ 0.5 USD for thresholding purposes.
  const maticPerUsd = 2n;

  for (const pool of cleanPools) {
    const addr = pool.address.toLowerCase();
    const state = stateCache.get(addr) as Record<string, unknown> | undefined;

    // Optional: aggressive liquidity filtering if we have state and rates.
    if (state && !isInvalidState(state) && tokenToMaticRates && liquidityFloorUsd != null && liquidityFloorUsd > 0) {
      const proto = normalizeProtocol(pool.protocol);
      let poolLiquidityMatic = 0n;

      if (proto === "V2") {
        const r0 = state.reserve0 as bigint | undefined;
        const r1 = state.reserve1 as bigint | undefined;
        const rate0 = tokenToMaticRates.get(pool.token0.toLowerCase());
        const rate1 = tokenToMaticRates.get(pool.token1.toLowerCase());

        if (r0 != null && rate0 != null) poolLiquidityMatic += tokensToMaticWei(r0, rate0);
        if (r1 != null && rate1 != null) poolLiquidityMatic += tokensToMaticWei(r1, rate1);
      }

      const floorMatic = BigInt(Math.floor(liquidityFloorUsd)) * maticPerUsd * 10n ** 18n;
      if (poolLiquidityMatic > 0n && poolLiquidityMatic < floorMatic) {
        continue; // Skip dust pool
      }
    }

    poolMeta.set(addr, pool);
    stateRefs.set(addr, state ?? null);
    const t = pool.tokens ?? [];
    for (let i = 0; i < t.length; i++) {
      const tILower = t[i].toLowerCase();
      tokens.add(tILower);
    }
    const poolEdges = createEdgesForPool(pool, state);
    for (const edge of poolEdges) {
      const from = edge.tokenIn; // already lowercased Address
      if (!adjacency.has(from)) adjacency.set(from, []);
      adjacency.get(from)!.push(edge);
    }
  }
  return { adjacency, poolMeta, stateRefs, tokens };
}
