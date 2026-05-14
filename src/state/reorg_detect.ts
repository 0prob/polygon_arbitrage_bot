/**
 * src/reorg/detect.js — Chain reorganization detection
 *
 * Compares the stored rollback guard with the new one returned
 * by HyperSync. If the parent hash for an overlapping block
 * doesn't match, a reorg has occurred.
 */

import { isRecord } from "../utils/identity.ts";

function pick(obj: unknown, camelKey: string, snakeKey: string) {
  if (!isRecord(obj)) return undefined;
  return obj[camelKey] ?? obj[snakeKey];
}

function storedRollbackGuard(registry: unknown) {
  if (!isRecord(registry) || typeof registry.getRollbackGuard !== "function") return null;
  const guard = registry.getRollbackGuard();
  return isRecord(guard) ? guard : null;
}

/**
 * Detect whether a chain reorg has occurred.
 *
 * @param {import('../db/registry.ts').RegistryService} registry
 * @param {object} newGuard  Rollback guard from the latest HyperSync response
 * @returns {number|false}   The block number where the reorg occurred, or false
 */
export function detectReorg(registry: unknown, newGuard: unknown) {
  if (!newGuard) return false;

  const stored = storedRollbackGuard(registry);
  if (!stored) return false;

  const storedHash = stored.block_hash;
  const storedBlock = Number(stored.block_number);
  const storedFirstBlock = Number(pick(stored, "firstBlockNumber", "first_block_number"));
  const storedFirstParent = pick(stored, "firstParentHash", "first_parent_hash");
  const newFirstParent = pick(newGuard, "firstParentHash", "first_parent_hash");
  const newFirstBlockRaw = pick(newGuard, "firstBlockNumber", "first_block_number");
  const newFirstBlock = Number(newFirstBlockRaw);

  if (!Number.isFinite(newFirstBlock) || !newFirstParent) {
    return false;
  }

  if (newFirstBlock === storedBlock && newFirstParent && storedHash) {
    if (newFirstBlock === storedBlock && newFirstParent !== storedHash) {
      return storedBlock;
    }
  }

  if (
    Number.isFinite(storedFirstBlock) &&
    newFirstBlock === storedFirstBlock &&
    storedFirstParent &&
    newFirstParent !== storedFirstParent
  ) {
    return newFirstBlock;
  }

  return false;
}
