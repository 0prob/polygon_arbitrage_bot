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
 * Mark an address as garbage and persist it to disk.
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
 * Get a copy of all currently known garbage addresses (lowercase).
 */
export function getAllGarbageAddresses(): string[] {
  return Array.from(garbageAddresses);
}

// Auto-load on module import (best-effort, non-blocking for startup)
loadGarbageAddresses().catch(() => {
  // Already handled inside the function
});
