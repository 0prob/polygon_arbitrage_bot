import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";

const GARBAGE_FILE = path.resolve("data/garbage-addresses.json");

// In-memory set for fast lookups
const garbageAddresses = new Set<string>();

let loaded = false;
let loadingPromise: Promise<void> | null = null;

/**
 * Load persisted garbage addresses from disk (idempotent).
 */
export async function loadGarbageAddresses(): Promise<void> {
  if (loaded) return;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    try {
      const raw = await readFile(GARBAGE_FILE, "utf8");
      const list: string[] = JSON.parse(raw);
      if (Array.isArray(list)) {
        for (const addr of list) {
          if (typeof addr === "string" && addr.startsWith("0x")) {
            garbageAddresses.add(addr.toLowerCase());
          }
        }
      }
    } catch (err: any) {
      if (err.code !== "ENOENT") {
        console.warn("[garbage-tracker] Failed to load garbage addresses:", err.message);
      }
      // File doesn't exist yet — that's fine
    }
    loaded = true;
  })();

  return loadingPromise;
}

/**
 * Check if an address is known garbage (case-insensitive).
 */
export function isGarbageAddress(address: string): boolean {
  return garbageAddresses.has(address.toLowerCase());
}

/**
 * Mark an address (token or pool) as garbage and persist it to disk.
 * Safe to call multiple times for the same address.
 */
export async function markAsGarbage(address: string): Promise<void> {
  const lower = address.toLowerCase();
  if (garbageAddresses.has(lower)) return;

  garbageAddresses.add(lower);

  // Ensure data directory exists
  const dir = path.dirname(GARBAGE_FILE);
  await mkdir(dir, { recursive: true });

  // Write the full current set (simple and safe for this use case)
  const list = Array.from(garbageAddresses).sort();
  await writeFile(GARBAGE_FILE, JSON.stringify(list, null, 2), "utf8");
}

/**
 * Check if a pool is garbage (either because of its tokens or its own address).
 */
export function isGarbagePool(pool: { address: string; tokens?: string[] }): boolean {
  if (isGarbageAddress(pool.address)) {
    console.debug(`[garbage] Pool filtered: ${pool.address} is garbage address`);
    return true;
  }
  if (!pool.tokens || pool.tokens.length === 0) return false;
  const isGarbage = pool.tokens.some((t) => isGarbageAddress(t));
  if (isGarbage) {
    console.debug(`[garbage] Pool filtered: ${pool.address} contains garbage token`);
  }
  return isGarbage;
}

/**
 * Get a copy of all currently known garbage addresses (lowercase).
 */
export function getAllGarbageAddresses(): string[] {
  return Array.from(garbageAddresses);
}

// Auto-load on module import (best-effort, non-blocking for startup)
loadGarbageAddresses().catch(() => {
  // Already handled inside the function
});

/**
 * Factories we actively index. If one of these appears as a "token" in a pool (or the pool addr),
 * it is garbage from a broken factory event emission. Single source of truth.
 */
export const KNOWN_INDEXED_FACTORIES = new Set([
  "0x5757371414417b8c6caad45baef941abc7d3ab32", // Quickswap V2
  "0xc35dadb65012ec5796536bd9864ed8773abc74c4", // Sushiswap V2
  "0x9e5a52f57b3038f1b8eee45f28b3c1967e22799c", // Uniswap V2
  "0x1f98431c8ad98523631ae4a59f267346ea31f984", // Uniswap V3
  "0x917933899c6a5f8e37f31e19f92cdbff7e8ff0e2", // Sushi V3
  "0x411b0facc3489691f28ad58c47006af5e3ab3a28", // Quickswap V3
]);

/**
 * One-time cleanup pass.
 * Scans all current pools from Hasura and auto-marks any tokens that match known factories
 * as garbage. This cleans up historical bad data from before the indexer-side filters existed.
 */
export async function performOneTimeGarbageCleanup(graphqlUrl: string, adminSecret: string): Promise<number> {
  if (!graphqlUrl) return 0;

  const knownFactories = KNOWN_INDEXED_FACTORIES;

  try {
    const { graphQLQuery } = await import("../hypersync/hyperindex_graphql.ts");
    const result = (await graphQLQuery(graphqlUrl, adminSecret, `{ PoolMeta(limit: 5000) { id tokens } }`)) as {
      PoolMeta?: Array<{ id?: string; tokens?: unknown }>;
    } | null;

    if (!result?.PoolMeta) return 0;

    let newlyMarked = 0;
    for (const pool of result.PoolMeta) {
      let tokens: string[] = [];
      if (typeof pool.tokens === "string") {
        try {
          tokens = JSON.parse(pool.tokens);
        } catch {}
      } else if (Array.isArray(pool.tokens)) {
        tokens = pool.tokens.map(String);
      }

      for (const token of tokens) {
        const lower = token.toLowerCase();
        if (knownFactories.has(lower) && !isGarbageAddress(lower)) {
          await markAsGarbage(lower);
          console.warn(`[garbage] One-time historical cleanup discovered new garbage address: ${lower}`);
          newlyMarked++;
        }
      }
    }
    return newlyMarked;
  } catch (err) {
    console.warn("[garbage-cleanup] One-time scan failed (non-fatal):", err);
    return 0;
  }
}
