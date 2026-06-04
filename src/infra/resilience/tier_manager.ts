import type { CircuitBreaker } from "./circuit_breaker.ts";

export type DegradationTier = "green" | "yellow" | "orange" | "red" | "black";

export class TierManager {
  private current: DegradationTier = "green";

  private hyperIndexMonitor: { isHealthy: () => boolean };

  constructor(
    private rpcCircuit: CircuitBreaker,
    private hasuraCircuit: CircuitBreaker,
    hyperIndexMonitor?: { isHealthy: () => boolean },
  ) {
    this.hyperIndexMonitor = hyperIndexMonitor ?? { isHealthy: () => true };
  }

  assess(): DegradationTier {
    const rpcHealthy = this.rpcCircuit.isHealthy();
    const hasuraHealthy = this.hasuraCircuit.isHealthy();
    const hyperIndexHealthy = this.hyperIndexMonitor.isHealthy();

    if (!rpcHealthy) {
      this.current = "black";
    } else if (!hasuraHealthy && !hyperIndexHealthy) {
      this.current = "red";
    } else if (!hasuraHealthy) {
      this.current = "orange";
    } else if (!hyperIndexHealthy) {
      this.current = "yellow";
    } else {
      this.current = "green";
    }

    return this.current;
  }

  getCurrent(): DegradationTier {
    return this.current;
  }

  /** Full pass loop: discovery, graph, cycles, simulation, execution */
  isFull(): boolean {
    return this.current === "green";
  }

  /** Should we attempt discovery (Hasura poll)? */
  shouldDiscover(): boolean {
    return this.current !== "red" && this.current !== "black" && this.current !== "orange";
  }

  /** Should we execute profitable opportunities? */
  shouldExecute(): boolean {
    return this.current === "green" || this.current === "yellow";
  }

  /** Should we enumerate cycles? */
  shouldEnumerate(): boolean {
    return this.current !== "black";
  }

  /** Should we simulate cycles? */
  shouldSimulate(): boolean {
    return this.current !== "black" && this.current !== "red";
  }

  /** Should we poll RPC for state? */
  shouldPollState(): boolean {
    return this.current !== "black";
  }

  /** Label for logging */
  label(): string {
    const descriptions: Record<DegradationTier, string> = {
      green: "Everything healthy — full pass loop",
      yellow: "HyperIndex lagging — using RPC state",
      orange: "Hasura down — RPC-only mode",
      red: "Multiple failures — monitoring only",
      black: "RPC unavailable — paused",
    };
    return `[${this.current.toUpperCase()}] ${descriptions[this.current]}`;
  }
}
