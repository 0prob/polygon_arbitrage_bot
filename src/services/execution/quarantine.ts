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
  private queue: string[] = [];
  private baseMs: number;
  private maxMs: number;

  constructor(baseMs: number = 2000, maxMs: number = 600_000) {
    this.baseMs = baseMs;
    this.maxMs = maxMs;
  }

  add(routeKey: string, error: string = ""): void {
    const existing = this.entries.get(routeKey);
    const attempt = existing ? existing.attempt + 1 : 1;
    const delay = Math.min(this.baseMs * Math.pow(2, attempt - 1), this.maxMs);
    this.entries.set(routeKey, {
      attempt,
      nextRetry: Date.now() + delay,
      lastError: error,
    });
    if (existing) {
      const idx = this.queue.indexOf(routeKey);
      if (idx !== -1) this.queue.splice(idx, 1);
    }
    this.queue.push(routeKey);
    if (this.queue.length > QUARANTINE_MAX_ENTRIES) {
      const oldest = this.queue.shift();
      if (oldest) this.entries.delete(oldest);
    }
  }

  isQuarantined(routeKey: string): boolean {
    const entry = this.entries.get(routeKey);
    if (!entry) return false;
    if (Date.now() >= entry.nextRetry) {
      this.entries.delete(routeKey);
      const idx = this.queue.indexOf(routeKey);
      if (idx !== -1) this.queue.splice(idx, 1);
      return false;
    }
    return true;
  }

  recordSuccess(routeKey: string): void {
    this.entries.delete(routeKey);
    const idx = this.queue.indexOf(routeKey);
    if (idx !== -1) this.queue.splice(idx, 1);
  }

  getEntry(routeKey: string): QuarantineEntry | undefined {
    return this.entries.get(routeKey);
  }

  prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now >= entry.nextRetry) {
        this.entries.delete(key);
        const idx = this.queue.indexOf(key);
        if (idx !== -1) this.queue.splice(idx, 1);
      }
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get all(): Map<string, QuarantineEntry> {
    return this.entries;
  }
}
