import type { Lifecycle } from "../../orchestrator/lifecycle.ts";
import type { Metrics } from "../../core/types/metrics.ts";
import type { CircuitBreaker } from "../resilience/circuit_breaker.ts";
import type { HyperIndexMonitor } from "../resilience/hyperindex_monitor.ts";
import type { DegradationTier } from "../resilience/tier_manager.ts";

export interface HealthPayload {
  status: "running" | "stopped" | "error";
  tier: DegradationTier;
  uptime: number;
  cycle: {
    current: number;
    lastDurationMs: number;
    cyclesPerMin: number;
  };
  execution: {
    attempted: number;
    succeeded: number;
    reverted: number;
    failed: number;
    opportunities: number;
  };
  hyperindex: {
    running: boolean;
    healthy: boolean;
  };
  rpc: {
    healthy: boolean;
  };
  hasura: {
    healthy: boolean;
  };
  routes: {
    tracked: number;
  };
  memory: {
    heapUsed: number;
    heapTotal: number;
  };
  timestamp: string;
}

export interface HealthDependencies {
  metrics: Metrics;
  rpcCircuit: CircuitBreaker;
  hasuraCircuit: CircuitBreaker;
  hyperIndexMonitor: HyperIndexMonitor;
  getTier: () => DegradationTier;
}

export class HealthServer implements Lifecycle {
  private server: ReturnType<typeof Bun.serve> | null = null;

  constructor(
    private port: number,
    private deps: HealthDependencies,
  ) {}

  async prepare(): Promise<void> {
    /* no-op */
  }

  async start(): Promise<void> {
    this.server = Bun.serve({
      port: this.port,
      fetch: (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/health") {
          return Response.json(this.buildHealthPayload(), {
            headers: { "Access-Control-Allow-Origin": "*" },
          });
        }
        if (url.pathname === "/metrics") {
          return new Response(this.buildMetricsText(), {
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    });
  }

  async stop(): Promise<void> {
    void this.server?.stop();
    this.server = null;
  }

  getPort(): number {
    return this.port;
  }

  private buildHealthPayload(): HealthPayload {
    const m = this.deps.metrics;
    const uptime = Math.floor((Date.now() - m.startTime) / 1000);
    const mem = process.memoryUsage();

    return {
      status: "running",
      tier: this.deps.getTier(),
      uptime,
      cycle: {
        current: m.cycles,
        lastDurationMs: m.lastCycleDurationMs,
        cyclesPerMin: m.currentCyclesPerMinute,
      },
      execution: {
        attempted: m.executionsAttempted,
        succeeded: m.executionsSuccessful,
        reverted: m.executionReverts,
        failed: m.executionsFailed,
        opportunities: m.opportunitiesFound,
      },
      hyperindex: {
        running: this.deps.hyperIndexMonitor.isRunning(),
        healthy: this.deps.hyperIndexMonitor.isHealthy(),
      },
      rpc: { healthy: this.deps.rpcCircuit.isHealthy() },
      hasura: { healthy: this.deps.hasuraCircuit.isHealthy() },
      routes: { tracked: m.trackedRoutes },
      memory: { heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
      timestamp: new Date().toISOString(),
    };
  }

  private buildMetricsText(): string {
    const m = this.deps.metrics;
    const tier = this.deps.getTier();
    const tierMap: Record<string, number> = { green: 0, yellow: 1, orange: 2, red: 3, black: 4 };

    return [
      `# HELP arb_cycles_total Total pass loop cycles`,
      `# TYPE arb_cycles_total counter`,
      `arb_cycles_total ${m.cycles}`,
      ``,
      `# HELP arb_cycle_duration_ms Last cycle duration`,
      `# TYPE arb_cycle_duration_ms gauge`,
      `arb_cycle_duration_ms ${m.lastCycleDurationMs}`,
      ``,
      `# HELP arb_opportunities_found_total Total opportunities detected`,
      `# TYPE arb_opportunities_found_total counter`,
      `arb_opportunities_found_total ${m.opportunitiesFound}`,
      ``,
      `# HELP arb_executions_attempted_total Total execution attempts`,
      `# TYPE arb_executions_attempted_total counter`,
      `arb_executions_attempted_total ${m.executionsAttempted}`,
      ``,
      `# HELP arb_executions_successful_total Successful transactions`,
      `# TYPE arb_executions_successful_total counter`,
      `arb_executions_successful_total ${m.executionsSuccessful}`,
      ``,
      `# HELP arb_executions_reverted_total Reverted transactions`,
      `# TYPE arb_executions_reverted_total counter`,
      `arb_executions_reverted_total ${m.executionReverts}`,
      ``,
      `# HELP arb_executions_failed_total Failed submissions`,
      `# TYPE arb_executions_failed_total counter`,
      `arb_executions_failed_total ${m.executionsFailed}`,
      ``,
      `# HELP arb_errors_total Total errors`,
      `# TYPE arb_errors_total counter`,
      `arb_errors_total ${m.totalErrors}`,
      ``,
      `# HELP arb_tier Current degradation tier (0=green, 1=yellow, 2=orange, 3=red, 4=black)`,
      `# TYPE arb_tier gauge`,
      `arb_tier ${tierMap[tier] ?? 4}`,
      ``,
      `# HELP arb_tracked_routes Number of tracked route keys`,
      `# TYPE arb_tracked_routes gauge`,
      `arb_tracked_routes ${m.trackedRoutes}`,
      ``,
      `# HELP arb_cycles_per_minute Current cycles per minute`,
      `# TYPE arb_cycles_per_minute gauge`,
      `arb_cycles_per_minute ${m.currentCyclesPerMinute}`,
      ``,
      `# HELP arb_uptime_seconds Bot uptime`,
      `# TYPE arb_uptime_seconds counter`,
      `arb_uptime_seconds ${Math.floor((Date.now() - m.startTime) / 1000)}`,
    ].join("\n");
  }
}
