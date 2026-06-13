export interface QuarantineEntry {
  attempt: number;
  nextRetry: number;
  lastError: string;
}

export const QUARANTINE_BASE_MS = 1_000;
export const QUARANTINE_MAX_MS = 300_000;
export const QUARANTINE_MAX_ENTRIES = 10_000;

export function computeBackoff(attempt: number): number {
  const delay = QUARANTINE_BASE_MS * Math.pow(2, attempt - 1);
  return Math.min(delay, QUARANTINE_MAX_MS);
}

export class QuarantineManager {
  private entries = new Map<string, QuarantineEntry>();
  private baseMs: number;
  private maxMs: number;
  /** Bumped on any mutation — invalidates HF cycle-filter caches. */
  private _revision = 0;

  constructor(baseMs: number = 2000, maxMs: number = 600_000) {
    this.baseMs = baseMs;
    this.maxMs = maxMs;
  }

  get revision(): number {
    return this._revision;
  }

  private bumpRevision(): void {
    this._revision++;
  }

  add(routeKey: string, error: string = ""): void {
    const existing = this.entries.get(routeKey);
    const attempt = existing ? existing.attempt + 1 : 1;
    const delay = Math.min(this.baseMs * Math.pow(2, attempt - 1), this.maxMs);

    // Re-insert to move to the end of Map (most recent for FIFO eviction)
    if (existing) {
      this.entries.delete(routeKey);
    }

    this.entries.set(routeKey, {
      attempt,
      nextRetry: Date.now() + delay,
      lastError: error,
    });

    if (this.entries.size > QUARANTINE_MAX_ENTRIES) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
      }
    }
    this.bumpRevision();
  }

  isQuarantined(routeKey: string): boolean {
    const entry = this.entries.get(routeKey);
    if (!entry) return false;

    if (Date.now() >= entry.nextRetry) {
      this.entries.delete(routeKey);
      this.bumpRevision();
      return false;
    }
    return true;
  }

  recordSuccess(routeKey: string): void {
    if (this.entries.delete(routeKey)) this.bumpRevision();
  }

  getEntry(routeKey: string): QuarantineEntry | undefined {
    return this.entries.get(routeKey);
  }

  prune(): void {
    const now = Date.now();
    let changed = false;
    for (const [key, entry] of this.entries) {
      if (now >= entry.nextRetry) {
        this.entries.delete(key);
        changed = true;
      }
    }
    if (changed) this.bumpRevision();
  }

  get size(): number {
    return this.entries.size;
  }

  get all(): Map<string, QuarantineEntry> {
    return this.entries;
  }
}
