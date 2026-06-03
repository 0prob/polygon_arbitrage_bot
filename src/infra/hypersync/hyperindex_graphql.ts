import { isGarbagePool } from "../../core/constants.ts";
import { markAsGarbage } from "../garbage/garbage-tracker.ts";
import type { Logger } from "../observability/logger.ts";

// Factories we actively index. If one of these addresses appears as a "token"
// in a pool, it is almost certainly garbage data from a broken PairCreated event.
const KNOWN_FACTORIES = new Set([
  "0x5757371414417b8c6caad45baef941abc7d3ab32", // Quickswap V2
  "0xc35dadb65012ec5796536bd9864ed8773abc74c4", // Sushiswap V2
  "0x9e5a52f57b3038f1b8eee45f28b3c1967e22799c", // Uniswap V2
  "0x1f98431c8ad98523631ae4a59f267346ea31f984", // Uniswap V3
  "0x917933899c6a5f8e37f31e19f92cdbff7e8ff0e2", // Sushi V3
  "0x411b0facc3489691f28ad58c47006af5e3ab3a28", // Quickswap V3
]);

export interface HasuraPoolMeta {
  address: string;
  protocol: string;
  tokens: string[];
  fee: number;
}

// Narrow response shapes for the specific GraphQL queries we issue (reduces `any` + tsc noise on data)
interface PoolMetaRow {
  id: string;
  protocol: string;
  tokens: unknown;
  fee: number | null;
}
interface V2StateRow {
  id: string;
  reserve0: string;
  reserve1: string;
}
interface V3StateRow {
  id: string;
  sqrtPriceX96: string;
  tick: string;
  liquidity: string;
}
interface V4StateRow {
  id: string;
  sqrtPriceX96: string;
  liquidity: string;
  tick: string;
  fee: string;
  tickSpacing: string;
  hooks: string;
}
interface BalancerStateRow {
  id: string;
  poolId: string;
  balances: unknown;
  weights: unknown;
  amp?: string | null;
  swapFee: string;
  scalingFactors: unknown;
}
interface CurveStateRow {
  id: string;
  balances: unknown;
  A: string;
  fee: string;
  rates?: unknown;
}
interface DodoStateRow {
  id: string;
  baseReserve: string;
  quoteReserve: string;
  rStatus: number;
  k: string;
  fee: string;
  i: string;
  targetBase: string;
  targetQuote: string;
  lpFeeRate: string;
  mtFeeRate: string;
}
interface TokenMetaRow {
  id?: string;
  address?: string;
  decimals?: number | null;
}

interface GraphQLData {
  PoolMeta?: PoolMetaRow[];
  V2PoolState?: V2StateRow[];
  V3PoolState?: V3StateRow[];
  V4PoolState?: V4StateRow[];
  BalancerPoolState?: BalancerStateRow[];
  CurvePoolState?: CurveStateRow[];
  DodoPoolState?: DodoStateRow[];
  TokenMeta?: TokenMetaRow[];
}

export function parseBigIntArray(arr: unknown): bigint[] {
  if (typeof arr === "string") {
    try {
      return JSON.parse(arr).map((s: string) => BigInt(s));
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  return arr.map((s: unknown) => BigInt(s as string));
}

// Resilient anchor pools loader: the scripts/pools.json (82 Uniswap V3 anchors) may be
// missing in some environments (gitignored, generated, or minimal checkout).
// We fall back to empty; discoverPoolsFromHasura and fetcher already treat anchors as
// best-effort pre-fetch / fallback list.
let _staticAnchors: HasuraPoolMeta[] = [];
try {
  // @ts-expect-error - dynamic JSON import for optional pools.json (falls back gracefully)
  const mod = await import("../../../scripts/pools.json", { with: { type: "json" } } as unknown as { default?: unknown });
  const poolsJson = (mod.default ?? mod) as unknown[];
  if (Array.isArray(poolsJson)) {
    _staticAnchors = poolsJson.map((p: any) => ({
      address: p?.address ?? "",
      protocol: p?.protocol ?? "unknown",
      tokens: Array.isArray(p?.tokens) ? p.tokens : [],
      fee: p?.fee ?? 30,
    }));
  }
} catch {
  // silent fallback - bot will rely entirely on Hasura discovery
}

// Remove any garbage pools from static anchors (defensive)
_staticAnchors = _staticAnchors.filter((p) => !isGarbagePool(p));

// Auto-mark any factories that appear as tokens in our static anchors
for (const p of _staticAnchors) {
  for (const token of p.tokens) {
    if (KNOWN_FACTORIES.has(token)) {
      markAsGarbage(token)
        .then(() => console.warn(`[garbage] Auto-discovered garbage from static anchors: ${token} (persisted)`))
        .catch(() => {});
    }
  }
}

export const STATIC_ANCHORS: HasuraPoolMeta[] = _staticAnchors;

const GRAPHQL_TIMEOUT = 10_000;

export async function graphQLQuery(url: string, adminSecret: string, query: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GRAPHQL_TIMEOUT);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-hasura-admin-secret": adminSecret,
      },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      throw new Error(`GraphQL query failed: ${resp.statusText}`);
    }

    const json = (await resp.json()) as Record<string, unknown>;
    if (json.errors) {
      throw new Error(`GraphQL error: ${JSON.stringify(json.errors)}`);
    }

    return json.data;
  } finally {
    clearTimeout(timer);
  }
}

export interface HasuraPoolState {
  id: string;
  reserve0?: string;
  reserve1?: string;
  sqrtPriceX96?: string;
  tick?: string;
  liquidity?: string;
  initialized: boolean;
}

const _cachedState: Map<string, any> = new Map();
const MAX_CACHE_SIZE = 50000;
const CACHE_TTL_MS = 300000; // 5 minutes
let _lastCacheClear = 0;

function evictExpiredCacheEntries(): void {
  const now = Date.now();
  // Only clear cache every 5 minutes to avoid constant map recreation
  if (now - _lastCacheClear > CACHE_TTL_MS) {
    _cachedState.clear();
    _lastCacheClear = now;
  } else if (_cachedState.size > MAX_CACHE_SIZE) {
    // If size exceeded, clear oldest half (approximation)
    const entries = Array.from(_cachedState.entries());
    _cachedState.clear();
    // Keep second half (most recently added)
    const keepCount = Math.floor(MAX_CACHE_SIZE * 0.5);
    for (let i = entries.length - keepCount; i < entries.length; i++) {
      if (entries[i]) {
        _cachedState.set(entries[i][0], entries[i][1]);
      }
    }
  }
}

export async function buildStateCacheFromGraphQL(
  graphqlUrl: string,
  adminSecret: string,
  logger?: Pick<Logger, "warn" | "error">,
): Promise<Map<string, any>> {
  try {
    evictExpiredCacheEntries();

    // Optimize: Use single batched query instead of 6 separate requests
    const batchedQuery = `{
      V2PoolState(limit: 15000) { id reserve0 reserve1 }
      V3PoolState(limit: 15000) { id sqrtPriceX96 tick liquidity }
      V4PoolState(limit: 5000) { id sqrtPriceX96 liquidity tick fee tickSpacing hooks }
      BalancerPoolState(limit: 5000) { id poolId balances weights amp swapFee scalingFactors }
      CurvePoolState(limit: 5000) { id balances A fee rates }
      DodoPoolState(limit: 5000) { id baseReserve quoteReserve rStatus k fee i targetBase targetQuote lpFeeRate mtFeeRate }
    }`;

    const result = await graphQLQuery(graphqlUrl, adminSecret, batchedQuery);
    const data = result as GraphQLData | null;

    if (!data) {
      throw new Error("No data returned from batched GraphQL query");
    }

    // Clear and rebuild cache with new data
    _cachedState.clear();

    // Process all state types efficiently
    const v2States = data.V2PoolState ?? [];
    for (const s of v2States) {
      _cachedState.set(s.id.toLowerCase(), {
        reserve0: BigInt(s.reserve0),
        reserve1: BigInt(s.reserve1),
      });
    }

    const v3States = data.V3PoolState ?? [];
    for (const s of v3States) {
      _cachedState.set(s.id.toLowerCase(), {
        sqrtPriceX96: BigInt(s.sqrtPriceX96),
        tick: Number(s.tick),
        liquidity: BigInt(s.liquidity),
      });
    }

    const v4States = data.V4PoolState ?? [];
    for (const s of v4States) {
      _cachedState.set(s.id.toLowerCase(), {
        sqrtPriceX96: BigInt(s.sqrtPriceX96),
        liquidity: BigInt(s.liquidity),
        tick: Number(s.tick),
        fee: BigInt(s.fee),
        tickSpacing: Number(s.tickSpacing),
        hooks: s.hooks,
      });
    }

    const balancerStates = data.BalancerPoolState ?? [];
    for (const s of balancerStates) {
      _cachedState.set(s.id.toLowerCase(), {
        poolId: s.poolId,
        balances: parseBigIntArray(s.balances),
        weights: parseBigIntArray(s.weights),
        amp: s.amp ? BigInt(s.amp) : undefined,
        swapFee: BigInt(s.swapFee),
        scalingFactors: parseBigIntArray(s.scalingFactors),
      });
    }

    const curveStates = data.CurvePoolState ?? [];
    for (const s of curveStates) {
      _cachedState.set(s.id.toLowerCase(), {
        balances: parseBigIntArray(s.balances),
        A: BigInt(s.A),
        fee: BigInt(s.fee),
        rates: parseBigIntArray(s.rates),
      });
    }

    const dodoStates = data.DodoPoolState ?? [];
    for (const s of dodoStates) {
      _cachedState.set(s.id.toLowerCase(), {
        baseReserve: BigInt(s.baseReserve),
        quoteReserve: BigInt(s.quoteReserve),
        rStatus: s.rStatus,
        k: BigInt(s.k),
        fee: BigInt(s.fee),
        i: BigInt(s.i),
        targetBase: BigInt(s.targetBase),
        targetQuote: BigInt(s.targetQuote),
        lpFeeRate: BigInt(s.lpFeeRate),
        mtFeeRate: BigInt(s.mtFeeRate),
      });
    }
  } catch (err) {
    logger?.warn({ err }, "buildStateCacheFromGraphQL unexpected error");
    throw err;
  }

  return _cachedState;
}

export async function discoverPoolsFromHasura(
  graphqlUrl: string,
  adminSecret: string,
  logger?: Pick<Logger, "warn" | "error">,
): Promise<HasuraPoolMeta[]> {
  const anchors = STATIC_ANCHORS;
  const PAGE = 2500;
  const allRows: PoolMetaRow[] = [];

  // Paginate with offset to avoid silent truncation when >PAGE pools exist in Hasura
  for (let offset = 0; offset < 50000; offset += PAGE) {
    // hard safety cap (~20 pages)
    let pageResult: unknown = null;
    let ok = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        pageResult = await graphQLQuery(
          graphqlUrl,
          adminSecret,
          `{ PoolMeta(limit: ${PAGE}, offset: ${offset}) { id protocol tokens fee } }`,
        );
        const d = pageResult as GraphQLData | null;
        if (d?.PoolMeta) {
          allRows.push(...d.PoolMeta);
          ok = true;
          if (d.PoolMeta.length < PAGE) {
            // last page
            offset = 1e9;
          }
          break;
        }
      } catch {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
    if (!ok) break; // give up on persistent errors for this page
  }

  if (allRows.length === 0) {
    return anchors;
  }

  try {
    const discovered = allRows
      .filter((pm) => pm && pm.id && pm.protocol)
      .map((pm) => {
        let tokens: string[];
        if (typeof pm.tokens === "string") {
          try {
            tokens = JSON.parse(pm.tokens) as string[];
          } catch {
            tokens = [];
          }
        } else if (Array.isArray(pm.tokens)) {
          tokens = pm.tokens.map((t: unknown) => String(t));
        } else {
          tokens = [];
        }
        return {
          address: pm.id.toLowerCase(),
          protocol: pm.protocol,
          tokens: tokens.map((t) => t.toLowerCase()),
          fee: pm.fee ?? 30,
        };
      })
      .filter((p) => p.address.startsWith("0x") && p.tokens.length >= 2 && !isGarbagePool(p));

    const combined = [...anchors].filter((p) => !isGarbagePool(p));
    const seen = new Set(combined.map((a) => a.address.toLowerCase()));
    for (const p of discovered) {
      if (!seen.has(p.address.toLowerCase())) {
        combined.push(p);
        seen.add(p.address.toLowerCase());
      }
    }

    // Auto-discover garbage during sync: if any token in a pool is a factory
    // we actively index, it almost certainly came from a broken PairCreated event.
    for (const p of combined) {
      for (const token of p.tokens) {
        if (KNOWN_FACTORIES.has(token)) {
          markAsGarbage(token)
            .then(() => logger?.warn({ token }, "Auto-discovered garbage during pool sync (will be filtered from graph)"))
            .catch(() => {});
        }
      }
    }

    return combined;
  } catch (err) {
    logger?.error({ err }, "discoverPoolsFromHasura error parsing results");
    return anchors;
  }
}

export async function fetchTokenMetasFromHasura(
  graphqlUrl: string,
  adminSecret: string,
  logger?: Pick<Logger, "warn">,
): Promise<Map<string, { decimals: number }>> {
  const metas = new Map<string, { decimals: number }>();
  try {
    const result = await graphQLQuery(graphqlUrl, adminSecret, `{ TokenMeta(limit: 5000) { id address decimals } }`);
    const rows = (result as GraphQLData | null)?.TokenMeta ?? [];
    for (const m of rows) {
      if (m.address && m.decimals != null) {
        metas.set(m.address.toLowerCase(), { decimals: Number(m.decimals) });
      }
    }
  } catch (err) {
    logger?.warn({ err }, "fetchTokenMetasFromHasura failed");
  }
  return metas;
}

export interface IndexerProgress {
  chainId: number;
  lastProcessedBlock: number;
  updatedAtBlock: number;
}

/**
 * Fetches the latest IndexerProgress written by the block handler.
 * Returns the first (and normally only) row, or undefined if the handler
 * has never run or the table is empty.
 */
export async function fetchIndexerProgressFromHasura(
  graphqlUrl: string,
  adminSecret: string,
  logger?: Pick<Logger, "warn">,
): Promise<IndexerProgress | undefined> {
  try {
    const result = await graphQLQuery(
      graphqlUrl,
      adminSecret,
      `{ IndexerProgress(limit: 5) { id chainId lastProcessedBlock updatedAtBlock } }`,
    );
    const rows =
      (result as { IndexerProgress?: Array<{ chainId: number; lastProcessedBlock: number; updatedAtBlock: number }> } | null)
        ?.IndexerProgress ?? [];

    if (rows.length === 0) return undefined;

    // Prefer the highest block if multiple chains ever appear
    const best = rows.reduce((a, b) => (b.lastProcessedBlock > a.lastProcessedBlock ? b : a));
    return {
      chainId: best.chainId,
      lastProcessedBlock: best.lastProcessedBlock,
      updatedAtBlock: best.updatedAtBlock,
    };
  } catch (err) {
    logger?.warn({ err }, "fetchIndexerProgressFromHasura failed");
    return undefined;
  }
}
