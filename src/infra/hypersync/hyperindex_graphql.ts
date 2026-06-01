import { isGarbagePool } from "../../core/constants.ts";
import { markAsGarbage } from "../garbage/garbage-tracker.ts";

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

export async function buildStateCacheFromGraphQL(graphqlUrl: string, adminSecret: string): Promise<Map<string, any>> {
  try {
    _cachedState.clear();
    const results = await Promise.allSettled([
      graphQLQuery(graphqlUrl, adminSecret, `{ V2PoolState(limit: 15000) { id reserve0 reserve1 } }`),
      graphQLQuery(graphqlUrl, adminSecret, `{ V3PoolState(limit: 15000) { id sqrtPriceX96 tick liquidity } }`),
      graphQLQuery(graphqlUrl, adminSecret, `{ V4PoolState(limit: 5000) { id sqrtPriceX96 liquidity tick fee tickSpacing hooks } }`),
      graphQLQuery(graphqlUrl, adminSecret, `{ BalancerPoolState(limit: 5000) { id poolId balances weights amp swapFee scalingFactors } }`),
      graphQLQuery(graphqlUrl, adminSecret, `{ CurvePoolState(limit: 5000) { id balances A fee rates } }`),
      graphQLQuery(
        graphqlUrl,
        adminSecret,
        `{ DodoPoolState(limit: 5000) { id baseReserve quoteReserve rStatus k fee i targetBase targetQuote lpFeeRate mtFeeRate } }`,
      ),
    ]);

    const queries = ["V2PoolState", "V3PoolState", "V4PoolState", "BalancerPoolState", "CurvePoolState", "DodoPoolState"];

    let anyFulfilled = false;
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === "rejected") {
        console.warn(`GraphQL query "${queries[i]}" failed:`, (results[i] as PromiseRejectedResult).reason);
      } else {
        anyFulfilled = true;
      }
    }

    if (!anyFulfilled) {
      throw new Error("All GraphQL state queries failed — HyperIndex endpoint unreachable");
    }

    const data0 = (results[0].status === "fulfilled" ? (results[0].value as { data?: GraphQLData })?.data : null) ?? {};
    const data1 = (results[1].status === "fulfilled" ? (results[1].value as { data?: GraphQLData })?.data : null) ?? {};
    const data2 = (results[2].status === "fulfilled" ? (results[2].value as { data?: GraphQLData })?.data : null) ?? {};
    const data3 = (results[3].status === "fulfilled" ? (results[3].value as { data?: GraphQLData })?.data : null) ?? {};
    const data4 = (results[4].status === "fulfilled" ? (results[4].value as { data?: GraphQLData })?.data : null) ?? {};
    const data5 = (results[5].status === "fulfilled" ? (results[5].value as { data?: GraphQLData })?.data : null) ?? {};

    const v2States = data0.V2PoolState ?? [];
    for (const s of v2States) {
      _cachedState.set(s.id.toLowerCase(), {
        reserve0: BigInt(s.reserve0),
        reserve1: BigInt(s.reserve1),
      });
    }

    const v3States = data1.V3PoolState ?? [];
    for (const s of v3States) {
      _cachedState.set(s.id.toLowerCase(), {
        sqrtPriceX96: BigInt(s.sqrtPriceX96),
        tick: Number(s.tick),
        liquidity: BigInt(s.liquidity),
      });
    }

    const v4States = data2.V4PoolState ?? [];
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

    const balancerStates = data3.BalancerPoolState ?? [];
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

    const curveStates = data4.CurvePoolState ?? [];
    for (const s of curveStates) {
      _cachedState.set(s.id.toLowerCase(), {
        balances: parseBigIntArray(s.balances),
        A: BigInt(s.A),
        fee: BigInt(s.fee),
        rates: parseBigIntArray(s.rates),
      });
    }

    const dodoStates = data5.DodoPoolState ?? [];
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
    console.warn("buildStateCacheFromGraphQL unexpected error", err);
    throw err;
  }

  return _cachedState;
}

export async function discoverPoolsFromHasura(graphqlUrl: string, adminSecret: string): Promise<HasuraPoolMeta[]> {
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
        const d = (pageResult as { data?: GraphQLData } | null)?.data;
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
            .then(() => console.warn(`[garbage] Auto-discovered during pool sync: ${token} (will be filtered from graph)`))
            .catch(() => {});
        }
      }
    }

    return combined;
  } catch (err) {
    console.error(`[discoverPoolsFromHasura] Error parsing results:`, err);
    return anchors;
  }
}

export async function fetchTokenMetasFromHasura(graphqlUrl: string, adminSecret: string): Promise<Map<string, { decimals: number }>> {
  const metas = new Map<string, { decimals: number }>();
  try {
    const result = await graphQLQuery(graphqlUrl, adminSecret, `{ TokenMeta(limit: 5000) { id address decimals } }`);
    const rows = (result as { data?: GraphQLData } | null)?.data?.TokenMeta ?? [];
    for (const m of rows) {
      if (m.address && m.decimals != null) {
        metas.set(m.address.toLowerCase(), { decimals: Number(m.decimals) });
      }
    }
  } catch (err) {
    console.warn("fetchTokenMetasFromHasura failed", err);
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
): Promise<IndexerProgress | undefined> {
  try {
    const result = await graphQLQuery(
      graphqlUrl,
      adminSecret,
      `{ IndexerProgress(limit: 5) { id chainId lastProcessedBlock updatedAtBlock } }`,
    );
    const rows = (result as { data?: { IndexerProgress?: Array<{ chainId: number; lastProcessedBlock: number; updatedAtBlock: number }> } } | null)?.data
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
    console.warn("fetchIndexerProgressFromHasura failed", err);
    return undefined;
  }
}
