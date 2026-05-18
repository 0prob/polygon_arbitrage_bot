import type { Logger } from "../infra/observability/logger.ts";

export interface CircuitBreakerOptions {
  maxConsecutiveFailures: number;
  windowMs: number;
  cooldownMs: number;
}

export const DEFAULT_CIRCUIT_BREAKER_OPTIONS: CircuitBreakerOptions = {
  maxConsecutiveFailures: 5,
  windowMs: 60_000,
  cooldownMs: 300_000,
};

export enum CircuitState {
  CLOSED = "CLOSED",
  OPEN = "OPEN",
  HALF_OPEN = "HALF_OPEN",
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureTimestamps: number[] = [];
  private openedAt: number = 0;

  constructor(
    private options: CircuitBreakerOptions = DEFAULT_CIRCUIT_BREAKER_OPTIONS,
    private logger?: Logger,
  ) {}

  getState(): CircuitState {
    return this.state;
  }

  recordSuccess(): void {
    this.failureTimestamps = [];
    if (this.state === CircuitState.HALF_OPEN) {
      this.state = CircuitState.CLOSED;
    }
  }

  recordFailure(): CircuitState {
    const now = Date.now();
    this.failureTimestamps = this.failureTimestamps.filter((ts) => now - ts < this.options.windowMs);
    this.failureTimestamps.push(now);
    if (this.failureTimestamps.length >= this.options.maxConsecutiveFailures) {
      this.state = CircuitState.OPEN;
      this.openedAt = now;
      this.logger?.warn({ circuitState: CircuitState.OPEN }, "Circuit breaker tripped");
    }
    return this.state;
  }

  allowExecution(): boolean {
    if (this.state === CircuitState.CLOSED || this.state === CircuitState.HALF_OPEN) {
      return true;
    }
    const now = Date.now();
    if (now - this.openedAt >= this.options.cooldownMs) {
      this.state = CircuitState.HALF_OPEN;
      this.logger?.info({ circuitState: CircuitState.HALF_OPEN }, "Circuit breaker entering half-open");
      return true;
    }
    return false;
  }

  reset(): void {
    this.state = CircuitState.CLOSED;
    this.failureTimestamps = [];
    this.openedAt = 0;
  }
}
