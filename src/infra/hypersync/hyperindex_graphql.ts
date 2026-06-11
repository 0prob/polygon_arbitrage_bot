import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isAddress } from "viem";
import type { PoolMeta } from "../../core/types/pool.ts";
import { isGarbagePool, KNOWN_INDEXED_FACTORIES, markAsGarbage } from "../garbage/garbage-tracker.ts";
import type { Logger } from "../observability/logger.ts";

const KNOWN_FACTORIES = KNOWN_INDEXED_FACTORIES;

interface PoolMetaRow {
  id: string;
  protocol: string;
  tokens: unknown;
  fee: number | null;
  createdBlock?: number;
}
interface V2StateRow {
  id: string;
  address: string;
  reserve0: string;
  reserve1: string;
}
interface V3StateRow {
  id: string;
  address: string;
  sqrtPriceX96: string;
  tick: string;
  liquidity: string;
}
interface V4StateRow {
  id: string;
  address: string;
  sqrtPriceX96: string;
  liquidity: string;
  tick: string;
  fee: string;
  tickSpacing: string;
  hooks: string;
}
interface BalancerStateRow {
  id: string;
  address: string;
  poolId: string;
  balances: unknown;
  weights: unknown;
  amp?: string | null;
  swapFee: string;
  scalingFactors: unknown;
}
interface CurveStateRow {
  id: string;
  address: string;
  balances: unknown;
  A: string;
  fee: string;
  rates?: unknown;
}
interface DodoStateRow {
  id: string;
  address: string;
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

const V2_STATE_FIELDS = "id address reserve0 reserve1";
const V3_STATE_FIELDS = "id address sqrtPriceX96 tick liquidity";
const V4_STATE_FIELDS = "id address sqrtPriceX96 liquidity tick fee tickSpacing hooks";
const BALANCER_STATE_FIELDS = "id address poolId balances weights amp swapFee scalingFactors";
const CURVE_STATE_FIELDS = "id address balances A fee rates";
const DODO_STATE_FIELDS = "id address baseReserve quoteReserve rStatus k fee i targetBase targetQuote lpFeeRate mtFeeRate";

const MAX_PAGE = 60;
const MAX_PAGE_SIZE = 10000;

export function parseBigIntArray(arr: unknown): bigint[] {
  if (typeof arr === "string") {
    try {
      return JSON.parse(arr).map((s: string) => BigInt(s));
    } catch (err) {
      console.warn("[hyperindex-graphql] Failed to parse bigint array:", err);
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  return arr.map((s: unknown) => BigInt(s as string));
}

let _staticAnchors: PoolMeta[] | null = null;
let staticAnchorsPromise: Promise<PoolMeta[]> | null = null;

async function loadStaticAnchors(): Promise<PoolMeta[]> {
  if (_staticAnchors) return _staticAnchors;
  if (staticAnchorsPromise) return staticAnchorsPromise;
  staticAnchorsPromise = (async () => {
    try {
      const __dirname = fileURLToPath(new URL(".", import.meta.url));
      const poolsPath = join(__dirname, "../../../scripts/pools.json");
      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(poolsPath, "utf-8");
      const poolsJson = JSON.parse(raw) as unknown[];
      let result: PoolMeta[] = [];
      if (Array.isArray(poolsJson)) {
        result = poolsJson.map((p) => {
          const row = p as Record<string, unknown>;
          const tokens: string[] = Array.isArray(row?.tokens) ? (row.tokens as string[]) : [];
          return {
            address: (row?.address ?? "") as `0x${string}`,
            protocol: (row?.protocol ?? "unknown") as string,
            token0: (tokens[0] ?? "") as `0x${string}`,
            token1: (tokens[1] ?? "") as `0x${string}`,
            tokens: tokens as `0x${string}`[],
            fee: (row?.fee ?? 30) as number,
          };
        });
      }
      result = result.filter((p) => !isGarbagePool(p));

      for (const p of result) {
        for (const token of p.tokens) {
          if (KNOWN_FACTORIES.has(token.toLowerCase())) {
            markAsGarbage(token)
              .then(() => console.warn(`[garbage] Auto-discovered garbage from static anchors: ${token} (persisted)`))
              .catch((err) => { console.warn("[garbage] Failed to persist garbage address:", err); });
          }
        }
      }

      _staticAnchors = result;
      return result;
    } catch (err) {
      console.warn("[hyperindex-graphql] Failed to load static anchors:", err);
      _staticAnchors = [];
      return [];
    }
  })();
  return staticAnchorsPromise;
}

export const STATIC_ANCHORS: PoolMeta[] = []; // placeholder, loaded lazily via loadStaticAnchors()

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

interface PaginatedFetchResult<T extends { id: string }> {
  rows: T[];
  maxBlock: number;
}

async function fetchPaginatedState<T extends { id: string; lastUpdatedBlock: number }>(
  graphqlUrl: string,
  adminSecret: string,
  table: string,
  fields: string,
  lastSeenBlock: number,
  pageSize: number,
): Promise<PaginatedFetchResult<T>> {
  const allRows: T[] = [];
  let maxBlock = lastSeenBlock;
  let cursorBlock: number | null = null;
  let cursorId: string | null = null;

  for (let page = 0; page < MAX_PAGE; page++) {
    let whereClause = "";
    if (cursorBlock != null && cursorId != null) {
      whereClause = `where: { _or: [ { lastUpdatedBlock: { _gt: ${cursorBlock} } }, { _and: [ { lastUpdatedBlock: { _eq: ${cursorBlock} } }, { id: { _gt: "${cursorId}" } } ] } ] }`;
    } else if (lastSeenBlock > 0) {
      whereClause = `where: { lastUpdatedBlock: { _gt: ${lastSeenBlock} } }`;
    }

    const query = `{ ${table}(limit: ${pageSize}, ${whereClause}, order_by: [{ lastUpdatedBlock: asc }, { id: asc }]) { ${fields} lastUpdatedBlock } }`;
    const result = await graphQLQuery(graphqlUrl, adminSecret, query);
    const rows: T[] | undefined = (result as any)?.[table];
    if (!rows || rows.length === 0) break;

    for (const r of rows) {
      if (r.lastUpdatedBlock > maxBlock) maxBlock = r.lastUpdatedBlock;
    }
    allRows.push(...rows);

    if (rows.length < pageSize) break;

    const last = rows[rows.length - 1];
    cursorBlock = last.lastUpdatedBlock;
    cursorId = last.id;
  }

  return { rows: allRows, maxBlock };
}

export interface BuildStateCacheOptions {
  lastSeenBlock?: number;
}

export interface BuildStateCacheResult {
  stateCache: Map<string, any>;
  maxSeenBlock: number;
}

export async function buildStateCacheFromGraphQL(
  graphqlUrl: string,
  adminSecret: string,
  logger?: Pick<Logger, "warn" | "error">,
  options: BuildStateCacheOptions = {},
): Promise<BuildStateCacheResult> {
  const stateCache = new Map<string, any>();
  const lastSeenBlock = options.lastSeenBlock ?? 0;
  let maxSeenBlock = lastSeenBlock;

  try {
    const [v2, v3, v4, bal, curve, dodo] = await Promise.all([
      fetchPaginatedState<V2StateRow & { lastUpdatedBlock: number }>(graphqlUrl, adminSecret, "V2PoolState", V2_STATE_FIELDS, lastSeenBlock, 25000),
      fetchPaginatedState<V3StateRow & { lastUpdatedBlock: number }>(graphqlUrl, adminSecret, "V3PoolState", V3_STATE_FIELDS, lastSeenBlock, 20000),
      fetchPaginatedState<V4StateRow & { lastUpdatedBlock: number }>(graphqlUrl, adminSecret, "V4PoolState", V4_STATE_FIELDS, lastSeenBlock, MAX_PAGE_SIZE),
      fetchPaginatedState<BalancerStateRow & { lastUpdatedBlock: number }>(graphqlUrl, adminSecret, "BalancerPoolState", BALANCER_STATE_FIELDS, lastSeenBlock, MAX_PAGE_SIZE),
      fetchPaginatedState<CurveStateRow & { lastUpdatedBlock: number }>(graphqlUrl, adminSecret, "CurvePoolState", CURVE_STATE_FIELDS, lastSeenBlock, MAX_PAGE_SIZE),
      fetchPaginatedState<DodoStateRow & { lastUpdatedBlock: number }>(graphqlUrl, adminSecret, "DodoPoolState", DODO_STATE_FIELDS, lastSeenBlock, MAX_PAGE_SIZE),
    ]);

    maxSeenBlock = Math.max(maxSeenBlock, v2.maxBlock, v3.maxBlock, v4.maxBlock, bal.maxBlock, curve.maxBlock, dodo.maxBlock);

    for (const s of v2.rows) {
      stateCache.set(s.address.toLowerCase(), {
        reserve0: BigInt(s.reserve0),
        reserve1: BigInt(s.reserve1),
      });
    }

    for (const s of v3.rows) {
      stateCache.set(s.address.toLowerCase(), {
        sqrtPriceX96: BigInt(s.sqrtPriceX96),
        tick: Number(s.tick),
        liquidity: BigInt(s.liquidity),
        initialized: true,
      });
    }

    for (const s of v4.rows) {
      stateCache.set(s.address.toLowerCase(), {
        sqrtPriceX96: BigInt(s.sqrtPriceX96),
        liquidity: BigInt(s.liquidity),
        tick: Number(s.tick),
        fee: BigInt(s.fee),
        tickSpacing: Number(s.tickSpacing),
        hooks: s.hooks,
        initialized: true,
      });
    }

    for (const s of bal.rows) {
      stateCache.set(s.address.toLowerCase(), {
        poolId: s.poolId,
        balances: parseBigIntArray(s.balances),
        weights: parseBigIntArray(s.weights),
        amp: s.amp ? BigInt(s.amp) : undefined,
        swapFee: BigInt(s.swapFee),
        scalingFactors: parseBigIntArray(s.scalingFactors),
        initialized: true,
      });
    }

    for (const s of curve.rows) {
      stateCache.set(s.address.toLowerCase(), {
        balances: parseBigIntArray(s.balances),
        A: BigInt(s.A),
        fee: BigInt(s.fee),
        rates: parseBigIntArray(s.rates),
        initialized: true,
      });
    }

    for (const s of dodo.rows) {
      stateCache.set(s.address.toLowerCase(), {
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
        initialized: true,
      });
    }
  } catch (err) {
    logger?.warn({ err }, "buildStateCacheFromGraphQL unexpected error");
    throw err;
  }

  return { stateCache, maxSeenBlock };
}

export function parsePoolMetaRows(rows: PoolMetaRow[]): PoolMeta[] {
  return rows
    .filter((pm) => pm && pm.id && pm.protocol)
    .map((pm) => {
      let tokens: string[];
      if (typeof pm.tokens === "string") {
        try {
          tokens = JSON.parse(pm.tokens) as string[];
        } catch (err) {
          console.warn("[hyperindex-graphql] Failed to parse pool tokens in discoverPools:", err);
          tokens = [];
        }
      } else if (Array.isArray(pm.tokens)) {
        tokens = pm.tokens.map((t: unknown) => String(t));
      } else {
        tokens = [];
      }
      tokens = tokens.map((t) => t.toLowerCase());
      return {
        address: pm.id.toLowerCase() as `0x${string}`,
        protocol: pm.protocol,
        token0: (tokens[0] ?? "") as `0x${string}`,
        token1: (tokens[1] ?? "") as `0x${string}`,
        tokens: tokens as `0x${string}`[],
        fee: pm.fee ?? 30,
      };
    })
    .filter((p) => isAddress(p.address) && p.tokens.length >= 2 && !isGarbagePool(p));
}

export interface DiscoverPoolsOptions {
  lastDiscoveredBlock?: number;
}

export async function discoverPoolsFromHasura(
  graphqlUrl: string,
  adminSecret: string,
  logger?: Pick<Logger, "warn" | "error">,
  options: DiscoverPoolsOptions = {},
): Promise<{ pools: PoolMeta[]; maxBlock: number }> {
  const anchors = await loadStaticAnchors();
  const PAGE = 2500;
  const allRows: PoolMetaRow[] = [];
  const lastDiscoveredBlock = options.lastDiscoveredBlock ?? 0;
  let maxBlock = lastDiscoveredBlock;
  const MAX_PAGES = 60;

  let cursorBlock: number | null = null;
  let cursorId: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    let pageResult: unknown = null;
    let ok = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        let where = "";
        if (lastDiscoveredBlock > 0 && cursorBlock == null) {
          where = `where: { createdBlock: { _gt: ${lastDiscoveredBlock} } }`;
        } else if (cursorBlock != null && cursorId != null) {
          where = `where: { _or: [ { createdBlock: { _gt: ${cursorBlock} } }, { _and: [ { createdBlock: { _eq: ${cursorBlock} } }, { id: { _gt: "${cursorId}" } } ] } ] }`;
        } else if (lastDiscoveredBlock > 0) {
          where = `where: { createdBlock: { _gt: ${lastDiscoveredBlock} } }`;
        }
        const query = `{ PoolMeta(limit: ${PAGE}, ${where}, order_by: [{ createdBlock: asc }, { id: asc }]) { id protocol tokens fee createdBlock } }`;
        pageResult = await graphQLQuery(graphqlUrl, adminSecret, query);
        const d = pageResult as { PoolMeta?: (PoolMetaRow & { createdBlock: number })[] } | null;
        if (d?.PoolMeta) {
          allRows.push(...d.PoolMeta);
          for (const row of d.PoolMeta) {
            if (row.createdBlock > maxBlock) maxBlock = row.createdBlock;
          }
          ok = true;
          if (d.PoolMeta.length < PAGE) {
            page = MAX_PAGES;
          } else {
            const last = d.PoolMeta[d.PoolMeta.length - 1];
            cursorBlock = last.createdBlock;
            cursorId = last.id;
          }
          break;
        }
      } catch (err) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
    if (!ok) break;
  }

  if (allRows.length === 0 && lastDiscoveredBlock > 0) {
    return { pools: [], maxBlock };
  }
  if (allRows.length === 0) {
    return { pools: anchors, maxBlock };
  }

  try {
    const discovered = parsePoolMetaRows(allRows);

    const combined = lastDiscoveredBlock > 0 ? [] : [...anchors].filter((p) => !isGarbagePool(p));
    const seen = new Set(combined.map((a) => a.address.toLowerCase()));

    for (let i = 0; i < discovered.length; i++) {
      const p = discovered[i];
      if (!seen.has(p.address.toLowerCase())) {
        combined.push(p);
        seen.add(p.address.toLowerCase());
      }
    }

    for (const p of combined) {
      for (const token of p.tokens) {
        if (KNOWN_FACTORIES.has(token)) {
          markAsGarbage(token)
            .then(() => logger?.warn({ token }, "Auto-discovered garbage during pool sync"))
            .catch((err) => { logger?.warn?.({ err, token }, "Failed to persist garbage during pool sync"); });
        }
      }
    }

    return { pools: combined, maxBlock };
  } catch (err) {
    logger?.error({ err }, "discoverPoolsFromHasura error parsing results");
    return { pools: anchors, maxBlock };
  }
}

export async function fetchTokenMetasFromHasura(
  graphqlUrl: string,
  adminSecret: string,
  logger?: Pick<Logger, "warn">,
): Promise<Map<string, { decimals: number }>> {
  const metas = new Map<string, { decimals: number }>();
  try {
    const PAGE = 10000;
    let cursorId: string | null = null;

    for (let page = 0; page < MAX_PAGE; page++) {
      let whereClause = "";
      if (cursorId != null) {
        whereClause = `where: { id: { _gt: "${cursorId}" } }`;
      }
      const query = `{ TokenMeta(limit: ${PAGE}, ${whereClause}, order_by: [{ id: asc }]) { address decimals } }`;
      const result = await graphQLQuery(graphqlUrl, adminSecret, query);
      const rows = (result as GraphQLData | null)?.TokenMeta ?? [];
      if (rows.length === 0) break;

      for (const m of rows) {
        if (m.address && m.decimals != null) {
          metas.set(m.address.toLowerCase(), { decimals: Number(m.decimals) });
        }
      }

      if (rows.length < PAGE) break;

      cursorId = rows[rows.length - 1].id ?? null;
      if (!cursorId) break;
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

export async function fetchIndexerProgressFromHasura(
  graphqlUrl: string,
  adminSecret: string,
  logger?: Pick<Logger, "warn">,
): Promise<IndexerProgress | undefined> {
  try {
    const result = await graphQLQuery(
      graphqlUrl,
      adminSecret,
      `{ IndexerProgress(limit: 5) { chainId lastProcessedBlock updatedAtBlock } }`,
    );
    const rows =
      (result as { IndexerProgress?: Array<{ chainId: number; lastProcessedBlock: number; updatedAtBlock: number }> } | null)
        ?.IndexerProgress ?? [];

    if (rows.length === 0) return undefined;

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
