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

let flushPromise: Promise<void> | null = null;

/**
 * Mark an address (token or pool) as garbage and persist it to disk.
 * Writes are batched automatically to prevent concurrent file corruption and I/O bottlenecks.
 */
export function markAsGarbage(address: string): Promise<void> {
  const lower = address.toLowerCase();
  if (garbageAddresses.has(lower)) return flushPromise || Promise.resolve();

  garbageAddresses.add(lower);

  if (!flushPromise) {
    flushPromise = Promise.resolve().then(async () => {
      // Small delay to allow batching of consecutive synchronous or rapid async calls
      await new Promise((r) => setTimeout(r, 50));

      const dir = path.dirname(GARBAGE_FILE);
      await mkdir(dir, { recursive: true });

      const list = Array.from(garbageAddresses).sort();
      await writeFile(GARBAGE_FILE, JSON.stringify(list, null, 2), "utf8");

      flushPromise = null;
    });
  }

  return flushPromise;
}

/**
 * Check if a pool is garbage (either because of its tokens or its own address).
 */
export function isGarbagePool(pool: { address: string; tokens?: string[] }): boolean {
  if (isGarbageAddress(pool.address)) return true;
  if (!pool.tokens || pool.tokens.length === 0) return false;
  return pool.tokens.some((t) => isGarbageAddress(t));
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
  "0xe7fb3e833efe5f9c441105eb65ef8b261266423b", // Dfyn V2
  "0xcf083be4164828f00cae704ec15a36d711491284", // Apeswap V2
  "0x9f3044f7f9fc8bc9ed615d54845b4577b833282d", // Meshswap V2
  "0x668ad0ed2622c62e24f0d5ab6b6ac1b9d2cd4ac7", // Jetswap V2
  "0x800b052609c355ca8103e06f022aa30647ead60a", // Cometh V2
  "0x1f98431c8ad98523631ae4a59f267346ea31f984", // Uniswap V3
  "0x917933899c6a5f8e37f31e19f92cdbff7e8ff0e2", // Sushi V3
  "0x411b0facc3489691f28ad58c47006af5e3ab3a28", // Quickswap V3
  "0x5f1dddbf348ac2fbe22a163e30f99f9ece3dd50a", // KyberSwap Elastic
  "0x79887f65f83bdf15bcc8736b5e5bcdb48fb8fe13", // DODO DVM
  "0xdfaf9584f5d229a9dbe5978523317820a8897c5a", // DODO DPP
  "0x4d97e480ea49ac57ce8c1f7c79b1a0c3d4adc7c4", // DODO DSP
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
    const promises: Promise<void>[] = [];
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
          promises.push(markAsGarbage(lower));
          console.warn(`[garbage] One-time historical cleanup discovered new garbage address: ${lower}`);
          newlyMarked++;
        }
      }
    }
    if (promises.length > 0) {
      await Promise.all(promises);
    }
    return newlyMarked;
  } catch (err) {
    console.warn("[garbage-cleanup] One-time scan failed (non-fatal):", err);
    return 0;
  }
}
