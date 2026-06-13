import { createEffect, S } from "envio";
import { parseAbi } from "viem";
import { publicClient } from "./rpc_client";
import path from "node:path";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { DAI, USDC, USDC_E, USDT, WBTC, WETH, WMATIC } from "../utils/constants";

const ROOT = import.meta.dir ?? ".";

let db: any = null;

/** Well-known Polygon tokens used by handler tests — avoids RPC when Vitest runs without bun:sqlite. */
const VITEST_TOKEN_DECIMALS: Record<string, number> = {
  [WMATIC]: 18,
  [WETH]: 18,
  [USDC_E]: 6,
  [USDT]: 6,
  [USDC]: 6,
  [DAI]: 18,
  [WBTC]: 8,
};

async function initDb() {
  if (db !== null) return;
  try {
    const { Database } = await import("bun:sqlite");
    db = new Database(path.resolve(ROOT, "../../token_registry.db"), { readonly: true });
  } catch {
    db = undefined;
    if (process.env.VITEST !== "true") {
      console.warn("[token_metadata] sqlite (bun:sqlite) unavailable, skipping static registry lookup");
    }
  }
}

const DISCOVERED_DECIMALS_FILE = path.resolve(ROOT, "../../../data/discovered-decimals.json");
const FAILED_DECIMALS_FILE = path.resolve(ROOT, "../../../data/failed-decimals.json");
const AUTO_EXTRA_TOKENS_FILE = path.resolve(ROOT, "../../../data/auto-extra-tokens.json");
// No TTL — a contract that isn't ERC20 will never become one. Permanent blocklist.

// Runtime discovered decimals (persisted across restarts for this indexer instance)
const discoveredDecimals: Record<string, number> = {};
let discoveredLoaded = false;
let discoveredSavePending: Promise<void> | null = null;

const registryCache: Map<string, number> = new Map();
let cacheLoaded = false;

function seedVitestRegistry(): void {
  for (const [addr, decimals] of Object.entries(VITEST_TOKEN_DECIMALS)) {
    registryCache.set(addr.toLowerCase(), decimals);
  }
}

async function warmUpCache() {
  if (cacheLoaded) return;
  await initDb();
  if (db) {
    const stmt = db.prepare("SELECT address, decimals FROM token_decimals");
    const rows = stmt.all() as { address: string; decimals: number }[];
    for (const row of rows) {
      let addr = row.address.toLowerCase();
      if (addr.startsWith("0x") && addr.length < 42) {
        addr = "0x" + addr.slice(2).padStart(40, "0");
      }
      registryCache.set(addr, row.decimals);
    }
  }
  if (process.env.VITEST === "true") {
    seedVitestRegistry();
  }
  cacheLoaded = true;
}

async function loadDiscoveredDecimals() {
  if (discoveredLoaded) return;
  try {
    const raw = await readFile(DISCOVERED_DECIMALS_FILE, "utf8");
    const data = JSON.parse(raw);
    if (data && typeof data === "object") {
      Object.assign(discoveredDecimals, data);
    }
  } catch {
    // File may not exist yet — that's fine
  }
  discoveredLoaded = true;
}

async function saveDiscoveredDecimals() {
  if (discoveredSavePending) return discoveredSavePending;
  discoveredSavePending = (async () => {
    try {
      await mkdir(path.dirname(DISCOVERED_DECIMALS_FILE), { recursive: true });
      await writeFile(DISCOVERED_DECIMALS_FILE, JSON.stringify(discoveredDecimals, null, 2), "utf8");
    } catch (e) {
      // Best effort
      console.warn("[token_metadata] Failed to persist discovered decimals:", (e as Error).message);
    } finally {
      discoveredSavePending = null;
    }
  })();
  return discoveredSavePending;
}

// Best-effort append of newly discovered cold tokens so the auto-update (generate-tokens:auto) promotes them on next indexer run / shutdown.
// can promote them into the static registry automatically.
const autoExtraWritePending = new Set<string>();

async function appendToAutoExtraTokens(address: string, decimals: number) {
  const addr = address;
  if (autoExtraWritePending.has(addr)) return;
  autoExtraWritePending.add(addr);

  try {
    await mkdir(path.dirname(AUTO_EXTRA_TOKENS_FILE), { recursive: true });

    let existing: Array<{ address?: string; decimals?: number }> = [];
    try {
      const raw = await readFile(AUTO_EXTRA_TOKENS_FILE, "utf8");
      existing = JSON.parse(raw);
      if (!Array.isArray(existing)) existing = [];
    } catch {}

    // Deduplicate
    if (existing.some((t) => t.address?.toLowerCase() === addr)) {
      return;
    }

    existing.push({ address: addr, decimals });
    await writeFile(AUTO_EXTRA_TOKENS_FILE, JSON.stringify(existing, null, 2), "utf8");
  } catch (e) {
    console.warn("[token_metadata] Failed to append to auto-extra-tokens:", (e as Error).message);
  } finally {
    autoExtraWritePending.delete(addr);
  }
}

// Permanent blocklist of addresses that are not ERC20 (no decimals()).
// A non-ERC20 contract never becomes one, so no TTL — skip forever.
const failedTokens: Set<string> = new Set();
let failedLoaded = false;
let failedSavePending: Promise<void> | null = null;

async function loadFailedTokens() {
  if (failedLoaded) return;
  failedLoaded = true;
  try {
    const raw = await readFile(FAILED_DECIMALS_FILE, "utf8");
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      for (const addr of data) failedTokens.add(addr);
    } else if (data && typeof data === "object") {
      // Migrate old timestamp-map format (keys are addresses)
      for (const addr of Object.keys(data)) failedTokens.add(addr);
    }
  } catch {
    // File may not exist yet
  }
}

async function saveFailedTokens() {
  if (failedSavePending) return failedSavePending;
  failedSavePending = (async () => {
    try {
      const tmpFile = FAILED_DECIMALS_FILE + ".tmp";
      await mkdir(path.dirname(FAILED_DECIMALS_FILE), { recursive: true });
      await writeFile(tmpFile, JSON.stringify([...failedTokens].sort(), null, 2), "utf8");
      await rename(tmpFile, FAILED_DECIMALS_FILE);
    } catch (e) {
      console.warn("[token_metadata] Failed to persist failed tokens:", (e as Error).message);
    } finally {
      failedSavePending = null;
    }
  })();
  return failedSavePending;
}

const ERC20_ABI = parseAbi(["function decimals() view returns (uint8)"]);

function safeDecimals(d: number): number {
  if (isNaN(d) || d < 0 || d > 255) return 18;
  return d;
}

/**
 * Fetches token decimals — optimized to avoid RPC as much as possible.
 *
 * Only decimals are pre-generated/sourced here because that is the *only*
 * token metadata the arbitrage engine actually uses (for amount scaling,
 * price impact, profit math, etc.).
 *
 * 1. Large static registry (fastest — 6000+ Polygon tokens, 0 RPC)
 * 2. Batched RPC (last resort)
 *
 * Cold tokens discovered via RPC are **automatically** appended to
 * `data/auto-extra-tokens.json` so the automatic token registry update promotes them (no manual `gentok` needed).
 * into the static registry.
 *
 * This is the #1 lever for V2Factory.PairCreated performance.
 */
// Used to deduplicate warnings when we repeatedly fail to fetch decimals for
// the same broken/malformed token (e.g. factory address emitted as a token).
const failedDecimalsTokens = new Set<string>();

const fetchTokenMetaHandler = async ({ input, context }: { input: { address: string }, context: any }) => {
    await warmUpCache();

    // Layer 1: In-memory static cache
    let addr = input.address.toLowerCase();
    if (addr.startsWith("0x") && addr.length < 42) {
      addr = "0x" + addr.slice(2).padStart(40, "0");
    }

    const cached = registryCache.get(addr);
    if (cached !== undefined) {
      return { address: addr, decimals: cached };
    }

    if (!discoveredLoaded) {
      await loadDiscoveredDecimals();
    }
    const discovered = discoveredDecimals[addr];
    if (discovered !== undefined) {
      return { address: addr, decimals: discovered };
    }

    // Layer 3: Permanent blocklist — non-ERC20 contracts never become valid
    if (!failedLoaded) {
      await loadFailedTokens();
    }
    const isFailed = failedTokens.has(addr);
    if (isFailed) {
      return { address: addr, decimals: 18 };
    }

    try {
      const decimals = await publicClient.readContract({
        address: addr as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "decimals",
      });

      const result = { address: addr, decimals: safeDecimals(Number(decimals)) };

      // Persist successful discovery aggressively
      discoveredDecimals[addr] = result.decimals;
      saveDiscoveredDecimals().catch(() => {});
      // ...
      // Auto-feed the gentok generator with newly discovered cold tokens.
      // This dramatically reduces future 15s effects on new launches.
      appendToAutoExtraTokens(addr, result.decimals).catch(() => {});

      if (context.log) {
        context.log.info(`Fetched decimals for new token via RPC (persisted + auto-extra)`, {
          token: addr,
          decimals: result.decimals,
        });
      }

      return result;
    } catch (err) {
      const errStr = String(err);

      // Distinguish between definitive "this is not an ERC20 token" errors
      // and transient "the network/RPC is having trouble" errors.
      const isDefinitiveError =
        errStr.includes("reverted") ||
        errStr.includes("not found") ||
        errStr.includes("Invalid address") ||
        errStr.includes("not a contract") ||
        errStr.includes("odd length") ||
        errStr.includes("cannot unmarshal");

      const isQuota =
        errStr.includes("Monthly") ||
        errStr.includes("capacity") ||
        errStr.includes("quota") ||
        errStr.includes("rate") ||
        errStr.includes("429");

      const isNetwork =
        errStr.includes("timeout") ||
        errStr.includes("failed to fetch") ||
        errStr.includes("HTTP") ||
        errStr.includes("500") ||
        errStr.includes("502") ||
        errStr.includes("503") ||
        errStr.includes("504");

      // Only add to permanent blocklist if it's a definitive non-token error.
      // Network/quota errors should be retried in a future run.
      // NOTE: "HTTP request failed" from viem might contain the inner RPC error.
      // We prioritize definitive errors over network wrappers.
      if (isDefinitiveError && !isQuota) {
        failedTokens.add(addr);
        saveFailedTokens().catch(() => {});
      }

      if (context.log && !failedDecimalsTokens.has(addr)) {
        failedDecimalsTokens.add(addr);

        if (isDefinitiveError && !isQuota) {
          context.log.warn(`Definitive failure fetching decimals for token — defaulting to 18 (added to permanent blocklist)`, {
            token: addr,
            error: errStr.split("\n")[0], // Keep logs clean
          });
        } else if (isQuota) {
          context.log.warn(
            `Alchemy quota / monthly capacity exceeded while fetching decimals. ` +
              `Add more providers to POLYGON_RPC_URLS (comma-separated) or lower effect rateLimits temporarily. ` +
              `Defaulting to 18 for this token (will retry in ~5min).`,
            { token: addr },
          );
        } else if (isNetwork) {
          context.log.warn(`Network error fetching decimals for token — defaulting to 18 (will retry in ~5min)`, {
            token: addr,
            error: errStr.split("\n")[0],
          });
        }
      }

      // Do not cache obviously bad/transient results forever in Envio effect cache.
      context.cache = false;
      return { address: addr, decimals: 18 };
    }
  };

export const fetchTokenMeta = createEffect(
  {
    name: "fetchTokenMeta",
    input: {
      address: S.string,
    },
    output: { address: S.string, decimals: S.number },
    rateLimit: { calls: 500, per: "second" },
    cache: process.env.NODE_ENV === 'test' ? false : true,
  },
  fetchTokenMetaHandler
);
export { fetchTokenMetaHandler };
