export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
  name?: string;
}

export const DEFAULT_CIRCUIT_OPTIONS: CircuitBreakerOptions = {
  failureThreshold: 3,
  cooldownMs: 30_000,
};

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failureCount = 0;
  private lastFailureTime = 0;
  private consecutiveSuccesses = 0;
  private readonly halfOpenMaxSuccesses = 2;

  constructor(
    private readonly name: string,
    private readonly opts: CircuitBreakerOptions = { ...DEFAULT_CIRCUIT_OPTIONS, name },
  ) {}

  getState(): CircuitState {
    if (this.state === "open" && this.isCooldownExpired()) {
      return "half-open";
    }
    return this.state;
  }

  isHealthy(): boolean {
    const s = this.getState();
    return s !== "open";
  }

  async execute<T>(fn: () => Promise<T>, fallback?: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (!this.isCooldownExpired()) {
        // Circuit is open and still cooling — use fallback if provided, otherwise throw.
        // (Avoiding a `never` return here prevents nasty control-flow type pollution downstream.)
        if (fallback) return await fallback();
        throw new Error(`Circuit breaker '${this.name}' is open (cooldown ${this.msUntilCooldown()}ms remaining)`);
      }
      this.state = "half-open";
      this.consecutiveSuccesses = 0;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      if (fallback) return await fallback();
      throw err;
    }
  }

  private onSuccess(): void {
    if (this.state === "half-open") {
      this.consecutiveSuccesses++;
      if (this.consecutiveSuccesses >= this.halfOpenMaxSuccesses) {
        this.reset();
      }
    } else {
      this.failureCount = 0;
    }
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    this.consecutiveSuccesses = 0;
    if (this.failureCount >= this.opts.failureThreshold) {
      this.state = "open";
    }
  }

  private isCooldownExpired(): boolean {
    return Date.now() - this.lastFailureTime >= this.opts.cooldownMs;
  }

  private msUntilCooldown(): number {
    return Math.max(0, this.opts.cooldownMs - (Date.now() - this.lastFailureTime));
  }

  getFailureCount(): number {
    return this.failureCount;
  }

  reset(): void {
    this.state = "closed";
    this.failureCount = 0;
    this.consecutiveSuccesses = 0;
    this.lastFailureTime = 0;
  }
}
