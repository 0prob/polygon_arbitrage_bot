import { createEffect, S } from "envio";
import { parseAbi } from "viem";
import { publicClient } from "./rpc_client";
import { STATIC_TOKEN_DECIMALS } from "./token_registry";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const DISCOVERED_DECIMALS_FILE = path.resolve("data/discovered-decimals.json");
const AUTO_EXTRA_TOKENS_FILE = path.resolve("data/auto-extra-tokens.json");
const FAILED_DECIMALS_RETRY_MS = 5 * 60 * 1000; // 5 minutes before retrying a failed token (reduced from 30m — transient RPC failures should recover quickly)

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

// Track failures with timestamps for retry
const failedTokenAttempts: Map<string, number> = new Map();

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

    // Layer 2: Check recent failure with backoff (aggressive failure handling)
    const lastFail = failedTokenAttempts.get(addr);
    if (lastFail && Date.now() - lastFail < FAILED_DECIMALS_RETRY_MS) {
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
      // Aggressive failure handling: remember the failure with timestamp
      failedTokenAttempts.set(addr, Date.now());

      // Never fail the whole indexing run for one bad token
      const errStr = String(err);
      const isQuota = errStr.includes("Monthly") || errStr.includes("capacity") || errStr.includes("quota") || errStr.includes("rate");

      if (context.log && !failedDecimalsTokens.has(addr)) {
        failedDecimalsTokens.add(addr);

        if (isQuota) {
          context.log.warn(
            `Alchemy quota / monthly capacity exceeded while fetching decimals. ` +
              `Add more providers to POLYGON_RPC_URLS (comma-separated) or lower effect rateLimits temporarily. ` +
              `Defaulting to 18 for this token (will retry in ~5min).`,
            { token: input.address },
          );
        } else {
          context.log.warn(`Failed to fetch decimals for token — defaulting to 18 (backoff applied)`, {
            token: input.address,
            error: errStr,
          });
        }
      }

      // Do not cache obviously bad results forever in Envio effect cache
      context.cache = false;
      return { address: input.address, decimals: 18 };
    }
  },
);
