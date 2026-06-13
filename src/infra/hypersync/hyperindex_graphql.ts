import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolMeta } from "../../core/types/pool.ts";
import { isGarbagePool, KNOWN_INDEXED_FACTORIES, markAsGarbage } from "../garbage/garbage-tracker.ts";
import type { Logger } from "../observability/logger.ts";
import { assertBotIndexerTable } from "../../pipeline/architecture.ts";

const KNOWN_FACTORIES = KNOWN_INDEXED_FACTORIES;

interface PoolMetaRow {
  id: string;
  protocol: string;
  tokens: unknown;
  fee: number | null;
  createdBlock?: number;
  poolId?: string | null;
}
interface TokenMetaRow {
  id?: string;
  address?: string;
  decimals?: number | null;
}

interface GraphQLData {
  PoolMeta?: PoolMetaRow[];
  TokenMeta?: TokenMetaRow[];
}

const MAX_PAGE = 60;
const MAX_PAGE_SIZE = 10000;
const GRAPHQL_TIMEOUT = 10_000;
const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/** Escape a value for use inside GraphQL double-quoted strings. */
export function escapeGraphQLString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Build `{ Table(limit: N, [where], order_by: ...) { fields } }` without stray commas. */
export function buildGraphQLListQuery(
  table: string,
  fields: string,
  options: { limit: number; where?: string; orderBy: string },
): string {
  const args: string[] = [`limit: ${options.limit}`];
  if (options.where) args.push(options.where);
  args.push(`order_by: ${options.orderBy}`);
  return `{ ${table}(${args.join(", ")}) { ${fields} } }`;
}

export function blockCursorWhere(
  blockField: string,
  lastBlock: number,
  cursorBlock: number | null,
  cursorId: string | null,
): string | undefined {
  if (cursorBlock != null && cursorId != null) {
    const id = escapeGraphQLString(cursorId);
    return `where: { _or: [ { ${blockField}: { _gt: ${cursorBlock} } }, { _and: [ { ${blockField}: { _eq: ${cursorBlock} } }, { id: { _gt: "${id}" } } ] } ] }`;
  }
  if (lastBlock > 0) {
    return `where: { ${blockField}: { _gt: ${lastBlock} } }`;
  }
  return undefined;
}

function idCursorWhere(cursorId: string | null): string | undefined {
  if (cursorId == null) return undefined;
  return `where: { id: { _gt: "${escapeGraphQLString(cursorId)}" } }`;
}

function isRetryableGraphQLError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return true;
  const msg = err.message;
  if (msg.includes("fetch failed") || msg.includes("ECONNRESET") || msg.includes("ETIMEDOUT")) {
    return true;
  }
  for (const code of TRANSIENT_HTTP_STATUSES) {
    if (msg.includes(String(code))) return true;
  }
  return false;
}

let _staticAnchors: PoolMeta[] | null = null;
let staticAnchorsPromise: Promise<PoolMeta[]> | null = null;

export async function loadStaticAnchors(): Promise<PoolMeta[]> {
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

async function graphQLQueryOnce(url: string, adminSecret: string, query: string): Promise<unknown> {
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
      throw new Error(`GraphQL query failed (${resp.status}): ${resp.statusText}`);
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

export async function graphQLQuery(
  url: string,
  adminSecret: string,
  query: string,
  retries = 2,
): Promise<unknown> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await graphQLQueryOnce(url, adminSecret, query);
    } catch (err) {
      lastErr = err;
      if (!isRetryableGraphQLError(err) || attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/** Accept 20-byte pool addresses and 32-byte pool keys (Uniswap V4 poolId). */
export function isValidPoolKey(id: string): boolean {
  if (!id.startsWith("0x")) return false;
  const hex = id.slice(2);
  if (hex.length !== 40 && hex.length !== 64) return false;
  return /^[0-9a-f]+$/.test(hex);
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
        poolId: pm.poolId ?? undefined,
      };
    })
    .filter((p) => isValidPoolKey(p.address) && p.tokens.length >= 2 && !isGarbagePool(p));
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
    let pageResult: unknown;
    try {
      assertBotIndexerTable("PoolMeta");
      const where = blockCursorWhere("createdBlock", lastDiscoveredBlock, cursorBlock, cursorId);
      const query = buildGraphQLListQuery(
        "PoolMeta",
        "id protocol tokens fee poolId createdBlock",
        {
          limit: PAGE,
          where,
          orderBy: "[{ createdBlock: asc }, { id: asc }]",
        },
      );
      pageResult = await graphQLQuery(graphqlUrl, adminSecret, query);
    } catch (err) {
      logger?.warn({ err, page }, "discoverPoolsFromHasura page fetch failed");
      break;
    }

    const d = pageResult as { PoolMeta?: (PoolMetaRow & { createdBlock: number })[] } | null;
    if (!d?.PoolMeta || d.PoolMeta.length === 0) break;

    allRows.push(...d.PoolMeta);
    for (const row of d.PoolMeta) {
      if (row.createdBlock > maxBlock) maxBlock = row.createdBlock;
    }

    if (d.PoolMeta.length < PAGE) break;

    const last = d.PoolMeta[d.PoolMeta.length - 1];
    cursorBlock = last.createdBlock;
    cursorId = last.id;
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
        if (KNOWN_FACTORIES.has(token.toLowerCase())) {
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
    let cursorId: string | null = null;

    for (let page = 0; page < MAX_PAGE; page++) {
      assertBotIndexerTable("TokenMeta");
      const query = buildGraphQLListQuery("TokenMeta", "id address decimals", {
        limit: MAX_PAGE_SIZE,
        where: idCursorWhere(cursorId),
        orderBy: "[{ id: asc }]",
      });
      const result = await graphQLQuery(graphqlUrl, adminSecret, query);
      const rows = (result as GraphQLData | null)?.TokenMeta ?? [];
      if (rows.length === 0) break;

      for (const m of rows) {
        if (m.address && m.decimals != null) {
          metas.set(m.address.toLowerCase(), { decimals: Number(m.decimals) });
        }
      }

      if (rows.length < MAX_PAGE_SIZE) break;

      cursorId = rows[rows.length - 1].id ?? null;
      if (!cursorId) break;
    }
  } catch (err) {
    logger?.warn({ err }, "fetchTokenMetasFromHasura failed");
  }
  return metas;
}

export async function fetchTokenMetasForAddresses(
  graphqlUrl: string,
  adminSecret: string,
  addresses: string[],
  logger?: Pick<Logger, "warn">,
): Promise<Map<string, { decimals: number }>> {
  const metas = new Map<string, { decimals: number }>();
  if (addresses.length === 0) return metas;

  const unique = [...new Set(addresses.map((a) => a.toLowerCase()))];
  const CHUNK = 500;

  try {
    for (let i = 0; i < unique.length; i += CHUNK) {
      assertBotIndexerTable("TokenMeta");
      const chunk = unique.slice(i, i + CHUNK);
      const inList = chunk.map((a) => `"${escapeGraphQLString(a)}"`).join(", ");
      const query = buildGraphQLListQuery("TokenMeta", "id address decimals", {
        limit: chunk.length,
        where: `where: { address: { _in: [${inList}] } }`,
        orderBy: "[{ id: asc }]",
      });
      const result = await graphQLQuery(graphqlUrl, adminSecret, query);
      const rows = (result as GraphQLData | null)?.TokenMeta ?? [];
      for (const m of rows) {
        if (m.address && m.decimals != null) {
          metas.set(m.address.toLowerCase(), { decimals: Number(m.decimals) });
        }
      }
    }
  } catch (err) {
    logger?.warn({ err, count: unique.length }, "fetchTokenMetasForAddresses failed");
  }
  return metas;
}

export interface IndexerProgress {
  chainId: number;
  lastProcessedBlock: number;
  updatedAtBlock: number;
  /** Chain head from the indexer's active data source (_meta.sourceBlock). */
  sourceBlock?: number;
  isReady?: boolean;
}

interface EnvioMetaRow {
  chainId: number;
  progressBlock: number;
  sourceBlock?: number;
  isReady?: boolean;
}

/**
 * Official Envio indexing metadata exposed via Hasura.
 * @see https://docs.envio.dev/docs/HyperIndex/metadata-query
 */
export async function fetchIndexerMetaFromHasura(
  graphqlUrl: string,
  adminSecret: string,
  chainId: number,
  logger?: Pick<Logger, "warn">,
): Promise<IndexerProgress | undefined> {
  try {
    const result = await graphQLQuery(
      graphqlUrl,
      adminSecret,
      `{ _meta(where: { chainId: { _eq: ${chainId} } }) { chainId progressBlock sourceBlock isReady } }`,
    );
    const rows = (result as { _meta?: EnvioMetaRow[] } | null)?._meta ?? [];
    const row = rows.find((r) => r.chainId === chainId) ?? rows[0];
    if (!row || row.progressBlock <= 0) return undefined;
    return {
      chainId: row.chainId,
      lastProcessedBlock: row.progressBlock,
      updatedAtBlock: row.progressBlock,
      sourceBlock: row.sourceBlock,
      isReady: row.isReady,
    };
  } catch (err) {
    logger?.debug?.({ err, chainId }, "fetchIndexerMetaFromHasura failed — falling back to IndexerProgress entity");
    return undefined;
  }
}

async function fetchLegacyIndexerProgressFromHasura(
  graphqlUrl: string,
  adminSecret: string,
  logger?: Pick<Logger, "warn">,
): Promise<IndexerProgress | undefined> {
  try {
    assertBotIndexerTable("IndexerProgress");
    const result = await graphQLQuery(
      graphqlUrl,
      adminSecret,
      buildGraphQLListQuery("IndexerProgress", "chainId lastProcessedBlock updatedAtBlock", {
        limit: 5,
        orderBy: "[{ lastProcessedBlock: desc }]",
      }),
    );
    const rows =
      (result as { IndexerProgress?: Array<{ chainId: number; lastProcessedBlock: number; updatedAtBlock: number }> } | null)
        ?.IndexerProgress ?? [];

    if (rows.length === 0) return undefined;

    const best = rows[0];
    if (!best) return undefined;
    return {
      chainId: best.chainId,
      lastProcessedBlock: best.lastProcessedBlock,
      updatedAtBlock: best.updatedAtBlock,
    };
  } catch (err) {
    logger?.warn({ err }, "fetchLegacyIndexerProgressFromHasura failed");
    return undefined;
  }
}

export async function fetchIndexerProgressFromHasura(
  graphqlUrl: string,
  adminSecret: string,
  logger?: Pick<Logger, "warn">,
  chainId = 137,
): Promise<IndexerProgress | undefined> {
  const meta = await fetchIndexerMetaFromHasura(graphqlUrl, adminSecret, chainId, logger);
  if (meta) return meta;
  return fetchLegacyIndexerProgressFromHasura(graphqlUrl, adminSecret, logger);
}
