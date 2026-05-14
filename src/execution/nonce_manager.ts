/**
 * src/execution/nonce_manager.js — Per-account nonce manager
 *
 * Tracks and increments nonces locally to allow rapid sequential
 * transaction submission without waiting for on-chain confirmation.
 *
 * Features:
 *   - Fetches current on-chain nonce on first use
 *   - Increments locally for subsequent transactions
 *   - Resync: re-fetches from chain (e.g. after a revert)
 *   - Thread-safe: uses a pending counter for concurrent submissions
 *
 * Usage:
 *   const nm = new NonceManager({ client: executionClient });
 *   const nonce = await nm.next(address);
 *   // submit tx with this nonce
 *   nm.confirm(address);   // increment confirmed counter
 *   nm.resync(address);    // re-fetch from chain on next call
 */

import { executionClient } from "./gas.ts";
import { logger } from "../utils/logger.ts";

export type NonceManagerClient = {
  getTransactionCount: (params: { address: `0x${string}`; blockTag: "pending" }) => Promise<bigint | number>;
};

export type NonceManagerState = {
  nonce: bigint;
  pending: number;
  pendingTotal: bigint;
  dirty: boolean;
};

export type NonceManagerOptions = {
  client?: NonceManagerClient;
  log?: (message: string) => void;
};

export class NonceManager {
  private _client: NonceManagerClient;
  private _state: Map<string, NonceManagerState>;
  private _syncing: Map<string, Promise<void>>;
  private _log: (message: string) => void;

  constructor(options: NonceManagerOptions = {}) {
    this._client = options.client ?? executionClient;
    this._state = new Map();
    this._syncing = new Map();
    this._log = options.log ?? console.log;
  }

  // ─── Helpers ─────────────────────────────────────────────────

  _key(address: string) {
    return address.toLowerCase();
  }

  async _fetchOnchain(address: string) {
    const count = await this._client.getTransactionCount({
      address: address as `0x${string}`,
      blockTag: "pending", // Include mempool txs in count
    });
    return BigInt(count);
  }

  async _ensureSynced(address: string, key: string) {
    const existing = this._syncing.get(key);
    if (existing) {
      await existing;
      return;
    }

    const syncPromise = (async () => {
      const onchain = await this._fetchOnchain(address);
      this._state.set(key, { nonce: onchain, pending: 0, pendingTotal: onchain, dirty: false });
      this._log(`[nonce_manager] ${address}: synced nonce=${onchain}`);
    })();

    this._syncing.set(key, syncPromise);
    try {
      await syncPromise;
    } finally {
      this._syncing.delete(key);
    }
  }

  // ─── Public API ──────────────────────────────────────────────

  /**
   * Get the next nonce for an address.
   *
   * On first call or after resync(), fetches from chain.
   * On subsequent calls, increments locally.
   *
   * @param {string} address  Sender address (0x-prefixed)
   * @param {object} [options]
   * @param {boolean} [options.once]  If true, return current nonce without incrementing
   * @returns {Promise<bigint>}  Nonce to use for the next transaction
   */
  async next(address: string, options?: { once?: boolean }): Promise<bigint> {
    const key = this._key(address);

    if (!this._state.has(key) || this._state.get(key)?.dirty) {
      await this._ensureSynced(address, key);
    }

    const entry = this._state.get(key);
    if (!entry) {
      throw new Error(`NonceManager failed to sync nonce for ${address}`);
    }
    if (!options?.once) {
      const nonce = entry.pendingTotal;
      entry.pending++;
      entry.pendingTotal = entry.nonce + BigInt(entry.pending);
      return nonce;
    }
    return entry.pendingTotal;
  }

  /**
   * Detect and recover from "nonce too high" errors after crash/restart.
   *
   * If a previously-submitted tx is still in the mempool with a higher nonce,
   * our local nonce is stale. This method fetches the on-chain nonce and
   * re-syncs, skipping any pending entries that were already submitted.
   *
   * @param {string} address  Sender address
   * @param {number} knownSubmitted  Number of txs we know were submitted
   */
  async recoverFromNonceTooHigh(address: string, knownSubmitted: number = 0): Promise<void> {
    const key = this._key(address);
    const onchainNonce = await this._fetchOnchain(address);

    // If we have submitted txs in-flight, the on-chain nonce is the base
    // for the *next* nonce. We need to account for in-flight submissions.
    const entry = this._state.get(key);
    const currentBase = entry?.nonce ?? 0n;

    if (onchainNonce > currentBase) {
      logger.warn(
        { address, onchainNonce: onchainNonce.toString(), currentBase: currentBase.toString(), knownSubmitted },
        "[nonce_manager] Detected nonce gap — resyncing from chain",
      );
    }

    // Set nonce to onchain value; pending counter reflects known in-flight txs.
    // If we know how many were submitted, preserve that count so we don't
    // double-send. Otherwise reset to 0 and let the caller re-verify.
    this._state.set(key, {
      nonce: onchainNonce,
      pending: knownSubmitted,
      pendingTotal: onchainNonce + BigInt(knownSubmitted),
      dirty: false,
    });
  }

  /**
   * Confirm a transaction was submitted (regardless of mined/reverted).
   * Increments the base nonce by 1.
   *
   * @param {string} address
   */
  confirm(address: string) {
    const key = this._key(address);
    const entry = this._state.get(key);
    if (!entry) return;

    entry.nonce++;
    if (entry.pending > 0) entry.pending--;
    entry.pendingTotal = entry.nonce + BigInt(entry.pending);
  }

  /**
   * Mark a transaction as reverted/dropped.
   * Decrements pending but does NOT increment base nonce.
   *
   * @param {string} address
   */
  revert(address: string) {
    const key = this._key(address);
    const entry = this._state.get(key);
    if (!entry) return;

    if (entry.pending > 0) entry.pending--;
  }

  /**
   * Mark a submitted transaction as dropped / lost from the mempool.
   * Force a resync so the next allocation uses chain state instead of the
   * locally advanced nonce.
   *
   * @param {string} address
   */
  markDropped(address: string) {
    this.resync(address);
  }

  /**
   * Force a resync from chain on next call to next().
   *
   * @param {string} address
   */
  resync(address: string) {
    const key = this._key(address);
    const entry = this._state.get(key);
    if (entry) {
      entry.dirty = true;
      entry.pending = 0;
    }
    this._log(`[nonce_manager] ${address}: marked for resync`);
  }

  /**
   * Get current local nonce state without fetching.
   *
   * @param {string} address
   * @returns {{ nonce: bigint, pending: number } | null}
   */
  peek(address: string): { nonce: bigint; pending: number; pendingTotal: bigint } | null {
    const entry = this._state.get(this._key(address));
    if (!entry) return null;
    return { nonce: entry.nonce, pending: entry.pending, pendingTotal: entry.pendingTotal };
  }

  /**
   * Reset all nonce state (e.g. on startup).
   */
  reset() {
    this._state.clear();
  }

  /**
   * Get a pending nonce without incrementing the counter (for tx inspection).
   */
  peekNext(address: string): bigint | null {
    const entry = this._state.get(this._key(address));
    if (!entry) return null;
    return entry.nonce + BigInt(entry.pending);
  }
}
