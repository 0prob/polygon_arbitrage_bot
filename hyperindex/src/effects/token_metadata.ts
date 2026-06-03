import { createEffect, S } from "envio";
import { parseAbi } from "viem";
import { publicClient } from "./rpc_client";
import { STATIC_TOKEN_DECIMALS } from "./token_registry";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";

const DISCOVERED_DECIMALS_FILE = path.resolve("data/discovered-decimals.json");
const FAILED_DECIMALS_FILE = path.resolve("data/failed-decimals.json");
const AUTO_EXTRA_TOKENS_FILE = path.resolve("data/auto-extra-tokens.json");
// No TTL — a contract that isn't ERC20 will never become one. Permanent blocklist.

// Runtime discovered decimals (persisted across restarts for this indexer instance)
const discoveredDecimals: Record<string, number> = {};
let discoveredLoaded = false;
let discoveredSavePending: Promise<void> | null = null;

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

// Best-effort append of newly discovered cold tokens so that `bun run gentok`
// can promote them into the static registry automatically.
const autoExtraWritePending = new Set<string>();

async function appendToAutoExtraTokens(address: string, decimals: number) {
  const addr = address;
  if (autoExtraWritePending.has(addr)) return;
  autoExtraWritePending.add(addr);

  try {
    await mkdir(path.dirname(AUTO_EXTRA_TOKENS_FILE), { recursive: true });

    let existing: any[] = [];
    try {
      const raw = await readFile(AUTO_EXTRA_TOKENS_FILE, "utf8");
      existing = JSON.parse(raw);
      if (!Array.isArray(existing)) existing = [];
    } catch {}

    // Deduplicate
    if (existing.some((t: any) => t.address?.toLowerCase() === addr)) {
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
 * `data/auto-extra-tokens.json` so the next `bun run gentok` promotes them
 * into the static registry.
 *
 * This is the #1 lever for V2Factory.PairCreated performance.
 */
// Used to deduplicate warnings when we repeatedly fail to fetch decimals for
// the same broken/malformed token (e.g. factory address emitted as a token).
const failedDecimalsTokens = new Set<string>();

export const fetchTokenMeta = createEffect(
  {
    name: "fetchTokenMeta",
    input: {
      address: S.string,
    },
    output: { address: S.string, decimals: S.number },
    rateLimit: { calls: 500, per: "second" }, // Pay-as-you-go Alchemy (historical eth_call + multicall). Batching in rpc_client keeps actual HTTP requests much lower.
    cache: true, // Critical for performance on restarts / re-runs
  },
  async ({ input, context }) => {
    const addr = input.address;

    // Layer 1: Static + discovered runtime cache (aggressive persistence)
    const staticCached = STATIC_TOKEN_DECIMALS[addr];
    if (staticCached !== undefined) {
      return { address: input.address, decimals: staticCached };
    }

    await loadDiscoveredDecimals();
    const discovered = discoveredDecimals[addr];
    if (discovered !== undefined) {
      return { address: input.address, decimals: discovered };
    }

    // Layer 2: Permanent blocklist — non-ERC20 contracts never become valid
    await loadFailedTokens();
    if (failedTokens.has(addr)) {
      return { address: input.address, decimals: 18 };
    }

    try {
      const decimals = await publicClient.readContract({
        address: input.address as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "decimals",
      });

      const result = { address: input.address, decimals: safeDecimals(Number(decimals)) };

      // Persist successful discovery aggressively
      discoveredDecimals[addr] = result.decimals;
      saveDiscoveredDecimals().catch(() => {});

      // Auto-feed the gentok generator with newly discovered cold tokens.
      // This dramatically reduces future 15s effects on new launches.
      appendToAutoExtraTokens(addr, result.decimals).catch(() => {});

      if (context.log) {
        context.log.info(`Fetched decimals for new token via RPC (persisted + auto-extra)`, {
          token: input.address,
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
        errStr.includes("not a contract");

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
      if (isDefinitiveError && !isQuota && !isNetwork) {
        failedTokens.add(addr);
        saveFailedTokens().catch(() => {});
      }

      if (context.log && !failedDecimalsTokens.has(addr)) {
        failedDecimalsTokens.add(addr);

        if (isQuota) {
          context.log.warn(
            `Alchemy quota / monthly capacity exceeded while fetching decimals. ` +
              `Add more providers to POLYGON_RPC_URLS (comma-separated) or lower effect rateLimits temporarily. ` +
              `Defaulting to 18 for this token (will retry in ~5min).`,
            { token: input.address },
          );
        } else if (isNetwork) {
          context.log.warn(`Network error fetching decimals for token — defaulting to 18 (will retry in ~5min)`, {
            token: input.address,
            error: errStr,
          });
        } else {
          context.log.warn(`Definitive failure fetching decimals for token — defaulting to 18 (added to permanent blocklist)`, {
            token: input.address,
            error: errStr,
          });
        }
      }

      // Do not cache obviously bad/transient results forever in Envio effect cache.
      // If it's definitive, Envio can cache it, but our Layer 2 blocklist already handles it.
      // If it's transient, we want Envio to retry.
      context.cache = false;
      return { address: input.address, decimals: 18 };
    }
  },
);
