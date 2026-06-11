import { withRetry } from "../../infra/rpc/retry.ts";

export type NonceFetcher = (address: string) => Promise<number>;

export interface StuckTxHandler {
  (nonce: number, maxFee: bigint): Promise<void>;
}

export class NonceManager {
  private localNonce: number | null = null;
  private pendingCount = 0;
  private inFlight = new Set<number>();
  private staleNonces = new Set<number>();
  private readonly maxStaleNonces = 20;

  constructor(
    private address: string,
    private fetchNonce: NonceFetcher,
    private onStuckTx?: StuckTxHandler,
  ) {}

  async initialize(): Promise<void> {
    try {
      this.localNonce = await withRetry(() => this.fetchNonce(this.address), { maxAttempts: 3 });
    } catch (err) {
      throw new Error(
        `NonceManager: failed to fetch initial nonce for ${this.address}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.pendingCount = 0;
    this.inFlight.clear();
    this.staleNonces.clear();
  }

  getNextNonce(): number {
    if (this.localNonce == null) throw new Error("NonceManager not initialized");
    const nonce = this.localNonce + this.pendingCount;
    this.pendingCount++;
    return nonce;
  }

  markInFlight(nonce: number): void {
    this.inFlight.add(nonce);
  }

  confirmNonce(confirmedNonce: number): void {
    if (this.localNonce != null && confirmedNonce >= this.localNonce) {
      const confirmedCount = confirmedNonce - this.localNonce + 1;
      this.localNonce = confirmedNonce + 1;
      this.pendingCount = Math.max(0, this.pendingCount - confirmedCount);
      // Clean up any stale nonces below the new confirmed nonce
      for (const n of this.staleNonces) {
        if (n <= confirmedNonce) this.staleNonces.delete(n);
      }
    }
    this.inFlight.delete(confirmedNonce);
  }

  markStale(nonce: number): void {
    this.staleNonces.add(nonce);
    if (this.staleNonces.size > this.maxStaleNonces) {
      const oldest = this.staleNonces.values().next().value;
      if (oldest != null) this.staleNonces.delete(oldest);
    }
    this.inFlight.delete(nonce);
  }

  getStaleCount(): number {
    return this.staleNonces.size;
  }

  /** Attempt recovery: clear the oldest stale nonce by sending a 0-value tx with higher gas. */
  async recoverStale(maxFee: bigint): Promise<boolean> {
    if (this.staleNonces.size === 0 || !this.onStuckTx) return false;
    const oldest = this.staleNonces.values().next().value;
    if (oldest == null) return false;
    try {
      const boostedFee = (maxFee * 150n) / 100n;
      await this.onStuckTx(oldest, boostedFee);
      this.staleNonces.delete(oldest);
      return true;
    } catch (err) {
      console.warn("[nonce] recoverStale failed:", err);
      return false;
    }
  }

  async resync(): Promise<void> {
    const chainNonce = await withRetry(() => this.fetchNonce(this.address), { maxAttempts: 3 });
    this.localNonce = chainNonce;
    this.pendingCount = 0;
    this.inFlight.clear();
    this.staleNonces.clear();
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  get expectedNextNonce(): number | null {
    return this.localNonce != null ? this.localNonce + this.pendingCount : null;
  }
}
