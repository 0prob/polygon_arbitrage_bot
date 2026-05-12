
/**
 * src/routing/finder.js — Arbitrage path finder
 *
 * Discovers candidate arbitrage cycles using:
 *   - 2-hop and 3-hop forward BFS
 *   - 4-hop bidirectional meet-in-middle BFS (O(E²) vs naive O(E⁴))
 *   - Log-space edge weights: log(spotOut/spotIn) − feeCost
 *   - Cumulative fee pre-computation per path (bps)
 *   - Liquidity floor pruning (skip edges with zero/near-zero reserves)
 *
 * Every emitted path is annotated with:
 *   path.logWeight         — sum of edge log-weights; negative = profitable
 *   path.cumulativeFeesBps — total fees along the path in basis points
 *
 * Bellman-Ford note: because each path is a *complete* cycle discovered by BFS,
 * checking logWeight < 0 is equivalent to detecting a negative-weight cycle in
 * Bellman-Ford — no separate graph-wide BF pass is needed.
 */

import { simulateCurveSwap } from "../math/curve.ts";
import { simulateBalancerSwap } from "../math/balancer.ts";
import { simulateDodoSwap } from "../math/dodo.ts";
import { simulateWoofiSwap } from "../math/woofi.ts";
import { toBigIntOrNull, toFiniteNumber } from "../utils/bigint.ts";
import { takeTopNBy } from "../utils/bounded_priority.ts";
import type { RouteState } from "./simulation_types.ts";
import type { RoutingGraph, SwapEdge } from "./graph.ts";
import type { RouteIdentityEdge } from "./route_identity.ts";
import { routeIdentityFromEdges } from "./route_identity.ts";
import { resolveSwapTokenIndexes } from "./swap_indices.ts";
import { poolLiquidityWmatic } from "./liquidity.ts";

// ─── Protocol sets ────────────────────────────────────────────

export type ArbPath = {
  startToken: string;
  edges: SwapEdge[];
  hopCount: number;
  logWeight: number;
  cumulativeFeesBps: number;
};

type PendingArbPath = Omit<ArbPath, "logWeight" | "cumulativeFeesBps"> & {
  logWeight?: number;
  cumulativeFeesBps?: number;
};

export type PathSearchGraph = Pick<RoutingGraph, "getEdges" | "getEdgesBetween" | "hasToken">;
export type StartTokenInput = string | Iterable<unknown> | null | undefined;
export type PathFinderOptions = {
  include2Hop?: boolean;
  include3Hop?: boolean;
  include4Hop?: boolean;
  minHops?: number;
  maxHops?: number;
  maxPaths?: number;
  maxPathsPerToken?: number;
  max4HopPathsPerToken?: number;
  maxNHopExpansionsPerToken?: number;
  maxExpansions?: number;
  minV2Reserve?: bigint;
  probeWei?: bigint;
  minLiquidityWmatic?: bigint;
  getRateWei?: ((token: string) => bigint) | null;
  tokenRateWeiByToken?: Record<string, unknown> | Map<string, unknown> | null;
};

type PruneOptions = Pick<PathFinderOptions, "minV2Reserve" | "probeWei" | "minLiquidityWmatic" | "getRateWei" | "tokenRateWeiByToken">;
type ResolvedCycleEnumeratorOptions = {
  include2Hop: boolean;
  include3Hop: boolean;
  include4Hop: boolean;
  minHops: number;
  maxHops: number;
  maxPathsPerToken: number;
  max4HopPathsPerToken: number;
  maxNHopExpansionsPerToken?: number;
  pruneOpts: PruneOptions;
};
type QuoteLogWeightFn = (
  amountIn: bigint,
  state: RouteState,
  tokenInIdx: number,
  tokenOutIdx: number,
) => { amountOut: bigint };

// ─── Log-weight helpers ───────────────────────────────────────



function anyNonPositiveBigInt(values: unknown[]) {
  return values.some((value) => {
    const bigintValue = toBigIntOrNull(value);
    return bigintValue != null && bigintValue <= 0n;
  });
}

function rateLookupFromOptions(opts: Pick<PathFinderOptions, "getRateWei" | "tokenRateWeiByToken">) {
  if (opts.getRateWei) return opts.getRateWei;
  const rates = opts.tokenRateWeiByToken;
  if (!rates) return null;
  return (token: string) => {
    const key = String(token).toLowerCase();
    const value = rates instanceof Map ? rates.get(key) : rates[key];
    const rate = toBigIntOrNull(value);
    return rate ?? 0n;
  };
}

/**
 * Convert a BigInt sqrtPriceX96 to a float safely.
 * sqrtPriceX96 can be up to 160 bits; direct Number() loses precision.
 *
 * We want the value of sqrtPriceX96 / 2^96 as a float.
 * Strategy: split into a high word (bits 96+) and a low 32-bit fractional
 * word so we retain 53 significant bits across the full 160-bit range.
 *
 *   hi  = sqrtPriceX96 >> 64          (integer, up to ~96 bits → fits float)
 *   frac= (sqrtPriceX96 >> 32) & 0xFFFFFFFF   (next 32 bits)
 *   result = (hi + frac/2^32) / 2^32  = sqrtPriceX96 / 2^96
 */
function sqrtPriceToFloat(sqrtPriceX96: bigint) {
  const hi   = Number(sqrtPriceX96 >> 64n);
  const frac = Number((sqrtPriceX96 >> 32n) & 0xFFFF_FFFFn) / (2 ** 32);
  return (hi + frac) / (2 ** 32);
}

function probeAmountFromBalance(balance: unknown) {
  const reserve = toBigIntOrNull(balance);
  if (reserve == null || reserve <= 0n) return 0n;
  const probe = reserve / 1_000_000n;
  return probe > 0n ? probe : 1n;
}

function positiveLog(value: unknown) {
  const bigintValue = toBigIntOrNull(value);
  if (bigintValue != null) {
    if (bigintValue <= 0n) return null;
    const digits = bigintValue.toString();
    if (digits.length <= 15) return Math.log(Number(bigintValue));

    const mantissaDigits = digits.slice(0, 15);
    const mantissa =
      mantissaDigits.length === 1
        ? Number(mantissaDigits)
        : Number(`${mantissaDigits[0]}.${mantissaDigits.slice(1)}`);
    return Math.log(mantissa) + (digits.length - 1) * Math.LN10;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.log(numeric);
}

function quoteBasedLogWeight(edge: SwapEdge, simulateFn: QuoteLogWeightFn) {
  const state = edge.stateRef;
  if (!state) return null;
  const balances = state?.balances;
  if (!Array.isArray(balances) || balances.length < 2) return null;

  const indexes = resolveSwapTokenIndexes(edge, state);
  if (!indexes) return null;
  const inIdx = indexes.tokenInIdx;
  const outIdx = indexes.tokenOutIdx;
  const balanceIn = balances[inIdx];
  const probeAmount = probeAmountFromBalance(balanceIn);
  if (probeAmount <= 0n) return null;

  let amountOut;
  try {
    ({ amountOut } = simulateFn(probeAmount, state, inIdx, outIdx));
  } catch {
    return null;
  }
  if (!amountOut || amountOut <= 0n) return null;

  const amountOutLog = positiveLog(amountOut);
  const probeAmountLog = positiveLog(probeAmount);
  if (amountOutLog == null || probeAmountLog == null) return null;

  return probeAmountLog - amountOutLog;
}

function dodoLogWeight(edge: SwapEdge) {
  const state = edge.stateRef;
  if (!state) return null;
  const balanceIn = edge.zeroForOne ? state.baseReserve : state.quoteReserve;
  const probeAmount = probeAmountFromBalance(balanceIn);
  if (probeAmount <= 0n) return null;

  let amountOut;
  try {
    ({ amountOut } = simulateDodoSwap(state, probeAmount, edge.zeroForOne));
  } catch {
    return null;
  }
  if (!amountOut || amountOut <= 0n) return null;

  const amountOutLog = positiveLog(amountOut);
  const probeAmountLog = positiveLog(probeAmount);
  if (amountOutLog == null || probeAmountLog == null) return null;

  return probeAmountLog - amountOutLog;
}

/**
 * Compute log(spotOut/spotIn) for a single edge using its live stateRef.
 *
 * V2: -log((rOut/rIn) * fee)
 * V3: -log(sqrtP² * (1 - fee))  (direction-adjusted)
 * Other (Balancer/Curve): return 0 (neutral — don't penalise unknowns)
 *
 * Returns null when state is unavailable or reserves are zero.
 *
 * @param {import('./graph.ts').SwapEdge} edge
 * @returns {number|null}
 */
export function edgeSpotLogWeight(edge: SwapEdge) {
  const state = edge.stateRef;
  if (!state) return null;

  if (edge.protocolKind === "v2") {
    const r0 = toBigIntOrNull(state.reserve0);
    const r1 = toBigIntOrNull(state.reserve1);
    if (r0 == null || r1 == null || r0 <= 0n || r1 <= 0n) return null;
    const [rIn, rOut] = edge.zeroForOne ? [r0, r1] : [r1, r0];
    const feeNumerator = toFiniteNumber(edge.fee ?? state.fee, 997);
    const feeDenominator = toFiniteNumber(edge.feeDenominator ?? state.feeDenominator, 1000);
    if (feeDenominator <= 0 || feeNumerator <= 0 || feeNumerator >= feeDenominator) return null;
    const logOut = positiveLog(rOut);
    const logIn = positiveLog(rIn);
    if (logOut == null || logIn == null) return null;
    return logIn - logOut - Math.log(feeNumerator / feeDenominator);
  }

  if (edge.protocolKind === "v3") {
    const sqrtP = toBigIntOrNull(state.sqrtPriceX96);
    if (sqrtP == null || sqrtP === 0n || !state.initialized) return null;
    const sqrtFloat = sqrtPriceToFloat(sqrtP); // ≈ sqrtPriceX96 / 2^96
    const price01 = sqrtFloat * sqrtFloat;      // token1 per token0
    if (price01 <= 0 || !isFinite(price01)) return null;
    const feeFrac = toFiniteNumber(edge.fee, 3000) / 1e6;
    const logSpot = edge.zeroForOne ? Math.log(price01) : -Math.log(price01);
    return -logSpot - Math.log(1 - feeFrac);
  }

  if (edge.protocol.startsWith("CURVE_")) {
    return quoteBasedLogWeight(edge, simulateCurveSwap);
  }

  if (edge.protocol.startsWith("BALANCER_")) {
    return quoteBasedLogWeight(edge, simulateBalancerSwap);
  }

  if (edge.protocol.startsWith("DODO_")) {
    return dodoLogWeight(edge);
  }

  if (edge.protocol === "WOOFI") {
    return quoteBasedLogWeight(edge, simulateWoofiSwap);
  }

  // Unknown protocols remain neutral so they are not over-penalized
  return 0;
}

/**
 * Compute cumulative fees for a path in basis points.
 * V2 = 30 bps; V3 fee is stored in ppm (hundredths of a bip) → divide by 100.
 *
 * @param {ArbPath} path
 * @returns {number}
 */
export function pathCumulativeFeesBps(path: Pick<ArbPath, "edges">) {
  let total = 0;
  for (const edge of path.edges) {
    total += edge.feeBps ?? 0;
  }
  return total;
}

/**
 * Annotate a path with logWeight and cumulativeFeesBps.
 *
 * logWeight < 0  → profitable at spot (before gas)
 * logWeight = 0  → insufficient state to evaluate (keep, let simulator decide)
 *
 * Fix: previously any null edge weight caused the entire path logWeight to be
 * set to 0, discarding all known weights. Now we sum the known weights and only
 * fall back to 0 when ALL edges are unknown (fully stateless path). Paths with
 * at least one known weight retain their partial score so ranking is meaningful.
 *
 * Mutates `path` in place and returns it.
 *
 * @param {ArbPath} path
 * @returns {ArbPath}
 */
export function annotatePath(path: PendingArbPath): ArbPath {
  let logWeight = 0;
  let knownEdges = 0;

  for (const edge of path.edges) {
    const w = edgeSpotLogWeight(edge);
    if (w !== null) {
      logWeight += w;
      knownEdges++;
    }
  }

  // If no edges had state, treat as neutral (0) so simulator gets a chance.
  // If at least one edge was known, use the partial sum — it's still a better
  // signal than zero and keeps paths ranked relative to each other.
  path.logWeight         = knownEdges === 0 ? 0 : logWeight;
  path.cumulativeFeesBps = pathCumulativeFeesBps(path);
  return path as ArbPath;
}

/**
 * Stable route identity that preserves execution order and direction.
 *
 * Pool-set deduplication is too destructive for cyclic arbitrage because the
 * same pools in a different order can be a different executable route.
 *
 * @param {string} startToken
 * @param {Array<{ poolAddress: string, zeroForOne: boolean }>} edges
 * @returns {string}
 */
export function routeKeyFromEdges(startToken: string, edges: RouteIdentityEdge[]) {
  return routeIdentityFromEdges(startToken, edges);
}

// ─── Pruning ──────────────────────────────────────────────────

/**
 * Return true if an edge should be pruned due to zero/near-zero liquidity.
 * This is a fast O(1) check using the live stateRef — no extra RPC calls.
 *
 * $5k USD liquidity check: rather than requiring an external price oracle here,
 * we use per-protocol raw thresholds:
 *   V2:  min(reserve0, reserve1) must be > minV2Reserve
 *   V3:  sqrtPriceX96 must be non-zero and liquidity > 0
 *
 * Callers that have access to token prices can apply tighter USD-denominated
 * checks using pruneLowLiquidityPaths() in enumerate_cycles.js.
 *
 * Price-impact check (0.3 %):
 *   For V2, a trade of `probeWei` into the pool impacts price by ≈ probeWei/reserveIn.
 *   We skip the edge if probeWei/reserveIn > 0.003.
 *   For V3/Balancer/Curve we rely on the log-weight being non-negative to filter out
 *   illiquid pools post-simulation.
 *
 * @param {import('./graph.ts').SwapEdge} edge
 * @param {object} opts
 * @param {bigint} [opts.minV2Reserve=0n]   Min raw reserve (per-token) for V2
 * @param {bigint} [opts.probeWei=0n]       Test trade size for 0.3 % impact check
 * @returns {boolean}  true = prune (skip this edge)
 */
function shouldPruneEdge(edge: SwapEdge, opts: PruneOptions = {}) {
  const { minV2Reserve = 0n, probeWei = 0n, minLiquidityWmatic = 0n } = opts;
  const state = edge.stateRef;
  if (!state) return false; // no state yet — let simulator reject it

  const getRateWei = rateLookupFromOptions(opts);
  if (minLiquidityWmatic > 0n && getRateWei) {
    const liquidity = poolLiquidityWmatic(edge, getRateWei);
    if (liquidity > 0n && liquidity < minLiquidityWmatic) return true;
  }

  if (edge.protocolKind === "v2") {
    const r0 = toBigIntOrNull(state.reserve0);
    const r1 = toBigIntOrNull(state.reserve1);
    if (r0 == null || r1 == null) return false;
    if (r0 <= 0n || r1 <= 0n) return true;

    if (minV2Reserve > 0n && (r0 < minV2Reserve || r1 < minV2Reserve)) return true;

    // Price-impact check: probeWei / reserveIn > 0.3 % → prune
    if (probeWei > 0n) {
      const rIn = edge.zeroForOne ? r0 : r1;
      if (rIn > 0n && probeWei * 1000n > rIn * 3n) return true; // impact > 0.3 %
    }

    return false;
  }

  if (edge.protocolKind === "v3") {
    const sqrtPriceX96 = toBigIntOrNull(state.sqrtPriceX96);
    const liquidity = toBigIntOrNull(state.liquidity);
    if (state.initialized === undefined || sqrtPriceX96 == null || liquidity == null) {
      return false;
    }
    if (!state.initialized) return true;
    if (sqrtPriceX96 === 0n) return true;
    if (liquidity <= 0n) return true;
    return false;
  }

  if (edge.protocol.startsWith("CURVE_")) {
    if (!Array.isArray(state.balances) || state.balances.length < 2) return false;
    if (anyNonPositiveBigInt(state.balances)) return true;
    const amplification = toBigIntOrNull(state.A);
    if (amplification == null || amplification <= 0n) return true;
    return false;
  }

  if (edge.protocol.startsWith("BALANCER_")) {
    if (!Array.isArray(state.balances) || state.balances.length < 2) return false;
    if (anyNonPositiveBigInt(state.balances)) return true;
    if (state.isStable === true || state.amp != null) {
      const amp = toBigIntOrNull(state.amp);
      if (amp == null || amp <= 0n) return true;
      if (!Array.isArray(state.scalingFactors) || state.scalingFactors.length !== state.balances.length) return true;
      if (anyNonPositiveBigInt(state.scalingFactors)) return true;
      return false;
    }
    if (!Array.isArray(state.weights) || state.weights.length < 2) return false;
    if (anyNonPositiveBigInt(state.weights)) return true;
    return false;
  }

  if (edge.protocol.startsWith("DODO_")) {
    const baseReserve = toBigIntOrNull(state.baseReserve);
    const quoteReserve = toBigIntOrNull(state.quoteReserve);
    if (baseReserve == null || quoteReserve == null) return false;
    if (baseReserve <= 0n || quoteReserve <= 0n) return true;
    const baseTarget = toBigIntOrNull(state.baseTarget);
    const quoteTarget = toBigIntOrNull(state.quoteTarget);
    if (baseTarget == null || quoteTarget == null) return false;
    if (baseTarget <= 0n || quoteTarget <= 0n) return true;
    const i = toBigIntOrNull(state.i);
    if (i == null || i <= 0n) return true;
    return false;
  }

  if (edge.protocol === "WOOFI") {
    if (!Array.isArray(state.balances) || state.balances.length < 2) return false;
    if (anyNonPositiveBigInt(state.balances)) return true;
    if (!isRecord(state.baseTokenStates)) return false;
    const inState = state.baseTokenStates[String(edge.tokenIn).toLowerCase()];
    const outState = state.baseTokenStates[String(edge.tokenOut).toLowerCase()];
    if (
      edge.tokenIn !== state.quoteToken &&
      (!isRecord(inState) || (toBigIntOrNull(inState.price) ?? 0n) <= 0n || inState.feasible === false)
    ) return true;
    if (
      edge.tokenOut !== state.quoteToken &&
      (!isRecord(outState) || (toBigIntOrNull(outState.price) ?? 0n) <= 0n || outState.feasible === false)
    ) return true;
    return false;
  }

  return false; // Balancer/Curve — let through, simulator handles
}

function normalizePathLimit(value: unknown, fallback: number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.floor(numeric);
}

function normalizeStartTokens(startTokens: StartTokenInput) {
  const normalize = (token: unknown) => {
    if (typeof token !== "string") return null;
    const trimmed = token.trim().toLowerCase();
    return trimmed.length > 0 ? trimmed : null;
  };
  if (typeof startTokens === "string") {
    const token = normalize(startTokens);
    return token ? [token] : [];
  }
  if (!startTokens || typeof startTokens[Symbol.iterator] !== "function") return [];
  return [...new Set([...startTokens].map(normalize).filter((token): token is string => token != null))];
}

function compareByPathLogWeight(a: ArbPath, b: ArbPath) {
  return toFiniteNumber(a?.logWeight) - toFiniteNumber(b?.logWeight);
}

function selectTopPathsByLogWeight(paths: ArbPath[], limit: number) {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  return takeTopNBy(paths, Math.floor(limit), compareByPathLogWeight);
}

function pushTopPath(paths: ArbPath[], path: PendingArbPath, limit: number) {
  const normalizedLimit = normalizePathLimit(limit, 0);
  if (normalizedLimit <= 0) return;
  paths.push(annotatePath(path));
  if (paths.length > normalizedLimit * 2) {
    const selected = selectTopPathsByLogWeight(paths, normalizedLimit);
    paths.length = 0;
    paths.push(...selected);
  }
}

function finalizeTopPaths(paths: ArbPath[], limit: number) {
  return selectTopPathsByLogWeight(paths, normalizePathLimit(limit, 0));
}

function findShortHopPaths(
  graph: PathSearchGraph,
  startToken: string,
  opts: PathFinderOptions = {},
  search: { include2Hop: boolean; include3Hop: boolean },
): ArbPath[] {
  const maxPaths = normalizePathLimit(opts.maxPaths, 10_000);
  const paths: ArbPath[] = [];
  const edgeCache = new Map<string, SwapEdge[]>();
  const betweenCache = new Map<string, SwapEdge[]>();

  const edgesFrom = (token: string) => {
    const key = token.toLowerCase();
    const cached = edgeCache.get(key);
    if (cached) return cached;
    const edges = graph.getEdges(token).filter((edge) => !shouldPruneEdge(edge, opts));
    edgeCache.set(key, edges);
    return edges;
  };
  const edgesBetween = (tokenIn: string, tokenOut: string) => {
    const key = `${tokenIn.toLowerCase()}:${tokenOut.toLowerCase()}`;
    const cached = betweenCache.get(key);
    if (cached) return cached;
    const edges = graph.getEdgesBetween(tokenIn, tokenOut).filter((edge) => !shouldPruneEdge(edge, opts));
    betweenCache.set(key, edges);
    return edges;
  };

  for (const e1 of edgesFrom(startToken)) {
    const tokenB = e1.tokenOut;
    if (tokenB === startToken) continue;

    if (search.include2Hop) {
      for (const ret of edgesBetween(tokenB, startToken)) {
        if (ret.poolAddress === e1.poolAddress) continue;
        pushTopPath(paths, { startToken, edges: [e1, ret], hopCount: 2 }, maxPaths);
      }
    }

    if (!search.include3Hop) continue;
    for (const e2 of edgesFrom(tokenB)) {
      const tokenC = e2.tokenOut;
      if (tokenC === startToken || tokenC === tokenB) continue;
      if (e2.poolAddress === e1.poolAddress) continue;

      for (const e3 of edgesBetween(tokenC, startToken)) {
        const p1 = e1.poolAddress, p2 = e2.poolAddress, p3 = e3.poolAddress;
        if (p3 === p1 || p3 === p2) continue;
        pushTopPath(paths, { startToken, edges: [e1, e2, e3], hopCount: 3 }, maxPaths);
      }
    }
  }

  return finalizeTopPaths(paths, maxPaths);
}

// ─── 2-hop paths ──────────────────────────────────────────────

/**
 * @typedef {Object} ArbPath
 * @property {string}   startToken
 * @property {import('./graph.ts').SwapEdge[]} edges
 * @property {number}   hopCount
 * @property {number}   logWeight        — sum of edge log-weights (annotated)
 * @property {number}   cumulativeFeesBps — total fees in bps (annotated)
 */

/**
 * Find all 2-hop arbitrage paths starting from a token.
 * A → B → A using two different pools.
 *
 * @param {import('./graph.ts').RoutingGraph} graph
 * @param {string} startToken
 * @param {object} [opts]
 * @param {bigint} [opts.minV2Reserve]
 * @param {bigint} [opts.probeWei]
 * @returns {ArbPath[]}
 */
export function find2HopPaths(graph: PathSearchGraph, startToken: string, opts: PathFinderOptions = {}): ArbPath[] {
  return findShortHopPaths(graph, startToken, opts, { include2Hop: true, include3Hop: false });
}

// ─── 3-hop paths ──────────────────────────────────────────────

/**
 * Find all 3-hop triangular paths: A → B → C → A.
 *
 * @param {import('./graph.ts').RoutingGraph} graph
 * @param {string} startToken
 * @param {object} [opts]
 * @param {number} [opts.maxPaths=10000]
 * @param {bigint} [opts.minV2Reserve]
 * @param {bigint} [opts.probeWei]
 * @returns {ArbPath[]}
 */
export function find3HopPaths(graph: PathSearchGraph, startToken: string, opts: PathFinderOptions = {}): ArbPath[] {
  return findShortHopPaths(graph, startToken, opts, { include2Hop: false, include3Hop: true });
}

// ─── 4-hop bidirectional ──────────────────────────────────────

/**
 * Find all 4-hop cycles using bidirectional meet-in-the-middle BFS.
 *
 * Naive approach is O(E⁴). This is O(E²) for each half + O(|fwd| × |bwd|) join,
 * effectively bounded by `maxPaths` in practice.
 *
 * A → B → C → D → A
 *  forward half:  A → B → C  (stored keyed by mid-token C)
 *  backward half: C → D → A  (stored keyed by meeting token C)
 *  join: combine pairs where all 4 pools are distinct.
 *
 * @param {import('./graph.ts').RoutingGraph} graph
 * @param {string} startToken
 * @param {object} [opts]
 * @param {number} [opts.maxPaths=2000]
 * @param {bigint} [opts.minV2Reserve]
 * @param {bigint} [opts.probeWei]
 * @returns {ArbPath[]}
 */
export function find4HopPathsBidirectional(graph: PathSearchGraph, startToken: string, opts: PathFinderOptions = {}): ArbPath[] {
  const maxPaths = normalizePathLimit(opts.maxPaths, 2_000);
  const paths: ArbPath[] = [];

  // ── Forward half: A → B → C ──────────────────────────────
  // fwd: midToken(C) → [ [e1, e2], ... ]
  const fwd = new Map<string, Array<[SwapEdge, SwapEdge]>>();

  for (const e1 of graph.getEdges(startToken)) {
    if (shouldPruneEdge(e1, opts)) continue;
    const tokenB = e1.tokenOut;
    if (tokenB === startToken) continue;

    for (const e2 of graph.getEdges(tokenB)) {
      if (shouldPruneEdge(e2, opts)) continue;
      const tokenC = e2.tokenOut;
      if (tokenC === startToken || tokenC === tokenB) continue;
      if (e2.poolAddress === e1.poolAddress) continue;

      if (!fwd.has(tokenC)) fwd.set(tokenC, []);
      fwd.get(tokenC)!.push([e1, e2]);
    }
  }

  if (fwd.size === 0) return paths;

  // ── Backward half: C → D → A (only from mid-tokens found above) ──
  // bwd: midToken(C) → [ [e3, e4], ... ]
  // Fix #4: cache getEdgesBetween(tokenD, startToken) lookups to avoid
  // repeated hash-map hits in the hot join loop on dense graphs.
  const bwd = new Map<string, Array<[SwapEdge, SwapEdge]>>();
  const returnEdgesCache = new Map<string, SwapEdge[]>();

  const getReturnEdges = (tokenD: string): SwapEdge[] => {
    const key = tokenD.toLowerCase();
    const cached = returnEdgesCache.get(key);
    if (cached) return cached;
    const edges = graph.getEdgesBetween(tokenD, startToken).filter((e) => !shouldPruneEdge(e, opts));
    returnEdgesCache.set(key, edges);
    return edges;
  };

  for (const [tokenC] of fwd) {
    for (const e3 of graph.getEdges(tokenC)) {
      if (shouldPruneEdge(e3, opts)) continue;
      const tokenD = e3.tokenOut;
      if (tokenD === startToken || tokenD === tokenC) continue;

      for (const e4 of getReturnEdges(tokenD)) {
        if (e4.poolAddress === e3.poolAddress) continue;

        if (!bwd.has(tokenC)) bwd.set(tokenC, []);
        bwd.get(tokenC)!.push([e3, e4]);
      }
    }
  }

  // ── Join at mid-token C ──────────────────────────────────
  for (const [tokenC, fwdPairs] of fwd) {
    const bwdPairs = bwd.get(tokenC);
    if (!bwdPairs) continue;

    for (const [e1, e2] of fwdPairs) {
      const p1 = e1.poolAddress, p2 = e2.poolAddress;
      for (const [e3, e4] of bwdPairs) {
        const p3 = e3.poolAddress, p4 = e4.poolAddress;
        // All 4 pools must be unique (bit-twiddling-free: 6 comparisons)
        if (p1 === p2 || p1 === p3 || p1 === p4 ||
                         p2 === p3 || p2 === p4 ||
                                      p3 === p4) continue;

        pushTopPath(paths, { startToken, edges: [e1, e2, e3, e4], hopCount: 4 }, maxPaths);
      }
    }
  }

  return finalizeTopPaths(paths, maxPaths);
}

// Backward-compat alias (old name → new bidirectional impl)
export const find4HopPaths = find4HopPathsBidirectional;

function findNHopPaths(graph: PathSearchGraph, startToken: string, exactHops: number, opts: PathFinderOptions = {}) {
  const maxPaths = normalizePathLimit(opts.maxPaths, 2_000);
  // 5+ hop DFS can explode on dense hub graphs; cap edge expansions so startup
  // cannot stall forever after warmup completes.
  const maxExpansions = normalizePathLimit(
    opts.maxExpansions,
    Math.max(25_000, maxPaths * 50),
  );
  if (!Number.isFinite(exactHops) || exactHops < 2) return [];

  const paths: ArbPath[] = [];
  const edges: SwapEdge[] = [];
  const usedPools = new Set<string>();
  const visitedTokens = new Set<string>();
  let expansions = 0;

  function dfs(currentToken: string, depth: number) {
    if (expansions >= maxExpansions) return;

    for (const edge of graph.getEdges(currentToken)) {
      if (expansions >= maxExpansions) return;
      expansions++;
      if (shouldPruneEdge(edge, opts)) continue;
      if (usedPools.has(edge.poolAddress)) continue;

      const nextToken = edge.tokenOut;
      const isFinalHop = depth + 1 === exactHops;

      if (isFinalHop) {
        if (nextToken !== startToken) continue;
      } else {
        if (nextToken === startToken) continue;
        if (visitedTokens.has(nextToken)) continue;
      }

      edges.push(edge);
      usedPools.add(edge.poolAddress);

      if (isFinalHop) {
        pushTopPath(paths, { startToken, edges: [...edges], hopCount: exactHops }, maxPaths);
      } else {
        visitedTokens.add(nextToken);
        dfs(nextToken, depth + 1);
        visitedTokens.delete(nextToken);
      }

      usedPools.delete(edge.poolAddress);
      edges.pop();
    }
  }

  dfs(startToken, 0);
  return finalizeTopPaths(paths, maxPaths);
}

export class CycleEnumerator {
  private graph: PathSearchGraph;

  constructor(graph: PathSearchGraph) {
    this.graph = graph;
  }

  enumerate(startTokens: StartTokenInput, opts: PathFinderOptions = {}): ArbPath[] {
    const allPaths: ArbPath[] = [];
    const search = this.resolveOptions(opts);
    for (const token of normalizeStartTokens(startTokens)) {
      allPaths.push(...this.enumerateTokenWithSearch(token, search));
    }
    return allPaths;
  }

  enumerateToken(startToken: string, opts: PathFinderOptions = {}): ArbPath[] {
    const token = normalizeStartTokens(startToken)[0];
    if (!token) return [];
    return this.enumerateTokenWithSearch(token, this.resolveOptions(opts));
  }

  private resolveOptions(opts: PathFinderOptions): ResolvedCycleEnumeratorOptions {
    const {
      include2Hop = true,
      include3Hop = true,
      include4Hop = false,
      minHops = 2,
      maxHops = 4,
      maxPathsPerToken = 5_000,
      max4HopPathsPerToken = 2_000,
      maxNHopExpansionsPerToken,
      minV2Reserve = 0n,
      probeWei = 0n,
      minLiquidityWmatic = 0n,
      getRateWei = null,
      tokenRateWeiByToken = null,
    } = opts;

    // Fix #5: if include4Hop is false, cap maxHops at 3 so callers can't
    // silently configure maxHops:5 and get zero 4/5-hop paths without a clue.
    const effectiveMaxHops = include4Hop ? maxHops : Math.min(Number(maxHops) || 3, 3);

    return {
      include2Hop,
      include3Hop,
      include4Hop,
      minHops: Math.max(2, Math.floor(Number(minHops) || 2)),
      maxHops: effectiveMaxHops,
      maxPathsPerToken,
      max4HopPathsPerToken,
      maxNHopExpansionsPerToken,
      pruneOpts: { minV2Reserve, probeWei, minLiquidityWmatic, getRateWei, tokenRateWeiByToken },
    };
  }

  private enumerateTokenWithSearch(startToken: string, search: ResolvedCycleEnumeratorOptions): ArbPath[] {
    if (!this.graph.hasToken(startToken)) return [];

    const tokenPaths: ArbPath[] = [];
    if (search.include2Hop || search.include3Hop) {
      tokenPaths.push(...this.enumerateForwardShortHops(startToken, search));
    }

    if (search.include4Hop) {
      const complexPaths = this.enumerateMeetInMiddle4Hop(startToken, search);
      tokenPaths.push(...complexPaths);
      tokenPaths.push(...this.enumerateBoundedLongHops(startToken, search));
    }

    return tokenPaths.filter((path) => path.hopCount >= search.minHops);
  }

  private enumerateForwardShortHops(startToken: string, search: ResolvedCycleEnumeratorOptions): ArbPath[] {
    const shortPaths = findShortHopPaths(this.graph, startToken, {
      ...search.pruneOpts,
      maxPaths: search.maxPathsPerToken,
    }, {
      include2Hop: search.include2Hop,
      include3Hop: search.include3Hop,
    });
    return selectTopPathsByLogWeight(shortPaths, search.maxPathsPerToken);
  }

  private enumerateMeetInMiddle4Hop(startToken: string, search: ResolvedCycleEnumeratorOptions): ArbPath[] {
    return find4HopPathsBidirectional(this.graph, startToken, {
      ...search.pruneOpts,
      maxPaths: search.max4HopPathsPerToken,
    });
  }

  private enumerateBoundedLongHops(
    startToken: string,
    search: ResolvedCycleEnumeratorOptions,
  ): ArbPath[] {
    // Fix #3: give 5+ hop paths their own budget equal to max4HopPathsPerToken
    // rather than sharing the 4-hop budget. Previously a full 4-hop run left
    // remainingComplexBudget=0 and silently skipped all 5+ hop paths.
    let remainingBudget = Math.max(0, Math.floor(search.max4HopPathsPerToken));
    const boundedMaxHops = Math.max(5, Math.floor(search.maxHops));
    const longPaths: ArbPath[] = [];

    for (let hopCount = 5; hopCount <= boundedMaxHops && remainingBudget > 0; hopCount++) {
      const nhopPaths = findNHopPaths(this.graph, startToken, hopCount, {
        ...search.pruneOpts,
        maxPaths: remainingBudget,
        maxExpansions: search.maxNHopExpansionsPerToken,
      });
      longPaths.push(...nhopPaths);
      remainingBudget -= nhopPaths.length;
    }

    return longPaths;
  }
}

// ─── Aggregated search ────────────────────────────────────────

/**
 * Find all arbitrage paths from a set of start tokens.
 *
 * All emitted paths are annotated with logWeight and cumulativeFeesBps.
 * Callers should sort by logWeight ascending (most negative = best opportunity).
 *
 * @param {import('./graph.ts').RoutingGraph} graph
 * @param {Set<string>|string[]}  startTokens
 * @param {object} [opts]
 * @param {boolean} [opts.include2Hop=true]
 * @param {boolean} [opts.include3Hop=true]
 * @param {boolean} [opts.include4Hop=false]
 * @param {number}  [opts.maxPathsPerToken=5000]    cap for 2+3-hop per token
 * @param {number}  [opts.max4HopPathsPerToken=2000] cap for 4-hop per token
 * @param {number}  [opts.maxNHopExpansionsPerToken] cap for 5+ hop DFS expansions per token
 * @param {bigint}  [opts.minV2Reserve=0n]   V2 per-token reserve floor
 * @param {bigint}  [opts.probeWei=0n]       probe trade size for 0.3 % impact
 * @returns {ArbPath[]}
 */
export function findArbPaths(graph: PathSearchGraph, startTokens: StartTokenInput, opts: PathFinderOptions = {}): ArbPath[] {
  return new CycleEnumerator(graph).enumerate(startTokens, opts);
}

// ─── Deduplication ───────────────────────────────────────────

/**
 * Remove paths that traverse the same set of pools (regardless of order).
 *
 * @param {ArbPath[]} paths
 * @returns {ArbPath[]}
 */
export function deduplicatePaths(paths: ArbPath[]): ArbPath[] {
  const seen   = new Set<string>();
  const unique: ArbPath[] = [];

  for (const path of paths) {
    const key = routeKeyFromEdges(path.startToken, path.edges);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(path);
    }
  }

  return unique;
}
import { isRecord } from "../utils/identity.ts";
