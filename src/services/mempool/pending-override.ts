import type { StateOverride, PendingOverrideEntry } from "../../core/types/state-override.ts";
import { mergeStateOverride } from "../../core/types/state-override.ts";
import type { Address } from "../../core/types/common.ts";

export interface PendingOverrideStoreOptions {
  ttlMs?: number;
  maxEntries?: number;
}

export class PendingOverrideStore {
  private entry: PendingOverrideEntry | null = null;
  private ttlMs: number;
  private maxEntries: number;

  constructor(opts?: PendingOverrideStoreOptions) {
    this.ttlMs = opts?.ttlMs ?? 200;
    this.maxEntries = opts?.maxEntries ?? 100;
  }

  /**
   * Merge a new state override into the store.
   * Later txs override earlier ones for the same storage slots.
   * Different pools are combined into a single override object.
   */
  update(override: StateOverride, affectedPools: string[], txHash: string): void {
    const now = Date.now();

    if (this.entry && now - this.entry.timestamp <= this.ttlMs) {
      const merged: StateOverride = {};
      mergeStateOverride(merged, this.entry.override);
      mergeStateOverride(merged, override);

      const pools = new Set(this.entry.affectedPools);
      for (const p of affectedPools) pools.add(p.toLowerCase());
      const txHashes = [...this.entry.txHashes, txHash].slice(-this.maxEntries);

      this.entry = { override: merged, affectedPools: pools, timestamp: now, txHashes };
    } else {
      const cloned: StateOverride = {};
      mergeStateOverride(cloned, override);

      const pools = new Set(affectedPools.map((p) => p.toLowerCase()));
      this.entry = { override: cloned, affectedPools: pools, timestamp: now, txHashes: [txHash] };
    }
  }

  /** Get the current active override, or null if expired. */
  get(): StateOverride | null {
    if (!this.entry) return null;
    if (Date.now() - this.entry.timestamp > this.ttlMs) {
      this.entry = null;
      return null;
    }
    return this.entry.override;
  }

  /** Get the set of pool addresses affected by the current override. */
  getAffectedPools(): Set<string> {
    return this.entry?.affectedPools ?? new Set();
  }

  /** Check if a specific pool is affected by the current override. */
  isAffected(poolAddress: Address): boolean {
    if (!this.entry) return false;
    return this.entry.affectedPools.has(poolAddress.toLowerCase());
  }

  /** Clear the override (e.g., on newHead). */
  clear(): void {
    this.entry = null;
  }

  /** Check if there is a valid (non-expired) override. */
  hasActive(): boolean {
    if (!this.entry) return false;
    if (Date.now() - this.entry.timestamp > this.ttlMs) {
      this.entry = null;
      return false;
    }
    return true;
  }

  getTtlMs(): number {
    return this.ttlMs;
  }
}
