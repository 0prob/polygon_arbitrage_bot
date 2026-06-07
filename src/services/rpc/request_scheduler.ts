export enum RequestPriority {
  CRITICAL = 0,
  HIGH = 1,
  LOW = 2,
}

interface PendingRequest<T> {
  priority: RequestPriority;
  execute: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  enqueuedAt: number;
}

export class RequestScheduler {
  private queues: [PendingRequest<unknown>[], PendingRequest<unknown>[], PendingRequest<unknown>[]];
  private tokens: number;
  private capacity: number;
  private refillRate: number;
  private lastRefill: number;
  private processing = false;
  private totalRequests = 0;

  constructor(rps: number = 250) {
    this.capacity = rps;
    this.tokens = rps;
    this.refillRate = rps;
    this.lastRefill = Date.now();
    this.queues = [[], [], []];
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }

  async acquire<T>(priority: RequestPriority, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const req: PendingRequest<T> = {
        priority,
        execute: fn,
        resolve,
        reject,
        enqueuedAt: Date.now(),
      };
      this.queues[priority].push(req as PendingRequest<unknown>);
      this.totalRequests++;
      if (!this.processing) {
        this.processing = true;
        queueMicrotask(() => this.processQueue());
      }
    });
  }

  private async processQueue(): Promise<void> {
    while (true) {
      this.refill();

      const req = this.dequeue();
      if (!req) {
        this.processing = false;
        return;
      }

      if (this.tokens >= 1) {
        this.tokens -= 1;
        req.execute().then(req.resolve).catch(req.reject);
      } else {
        this.queues[req.priority].unshift(req);
        const needed = 1 - this.tokens;
        const waitMs = Math.max(1, Math.ceil((needed / this.refillRate) * 1000));
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }

  private dequeue(): PendingRequest<unknown> | null {
    for (let p = 0; p < 3; p++) {
      if (this.queues[p].length > 0) {
        return this.queues[p].shift()!;
      }
    }
    return null;
  }

  getMetrics(): { pending: [number, number, number]; used: number; capacity: number; totalRequests: number } {
    return {
      pending: [this.queues[0].length, this.queues[1].length, this.queues[2].length],
      used: Math.round(this.capacity - this.tokens),
      capacity: this.capacity,
      totalRequests: this.totalRequests,
    };
  }
}
