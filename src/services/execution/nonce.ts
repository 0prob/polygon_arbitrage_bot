import { withRetry } from "../../infra/rpc/retry.ts";

export type NonceFetcher = (address: string) => Promise<number>;

export class NonceManager {
  private localNonce: number | null = null;
  private pendingCount = 0;

  constructor(
    private address: string,
    private fetchNonce: NonceFetcher,
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
  }

  getNextNonce(): number {
    if (this.localNonce == null) throw new Error("NonceManager not initialized");
    const nonce = this.localNonce + this.pendingCount;
    this.pendingCount++;
    return nonce;
  }

  async confirmNonce(confirmedNonce: number): Promise<void> {
    if (this.localNonce != null && confirmedNonce >= this.localNonce) {
      const confirmedCount = confirmedNonce - this.localNonce + 1;
      this.localNonce = confirmedNonce + 1;
      this.pendingCount = Math.max(0, this.pendingCount - confirmedCount);
    }
  }

  async resync(): Promise<void> {
    this.localNonce = await withRetry(() => this.fetchNonce(this.address), { maxAttempts: 3 });
    this.pendingCount = 0;
  }

  get expectedNextNonce(): number | null {
    return this.localNonce != null ? this.localNonce + this.pendingCount : null;
  }
}
