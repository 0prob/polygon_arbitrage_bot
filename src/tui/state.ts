import type { ArbEvent } from "./events.ts";

export interface MetricsState {
  opportunitiesFound: number;
  executed: number;
  successful: number;
  failed: number;
  totalProfitWei: bigint;
}

export interface SystemState {
  gasPriceWei: bigint;
  poolCount: number;
  cycleCount: number;
  lastCycleTimeMs: number;
}

export interface LogEntry {
  time: Date;
  component: string;
  message: string;
}

export interface TuiState {
  metrics: MetricsState;
  system: SystemState;
  log: LogEntry[];
  isRunning: boolean;
  isPaused: boolean;
  _startTime: number;
}

const MAX_LOG = 1000;

export function createInitialState(): TuiState {
  return {
    metrics: {
      opportunitiesFound: 0,
      executed: 0,
      successful: 0,
      failed: 0,
      totalProfitWei: 0n,
    },
    system: {
      gasPriceWei: 0n,
      poolCount: 0,
      cycleCount: 0,
      lastCycleTimeMs: 0,
    },
    log: [],
    isRunning: false,
    isPaused: false,
    _startTime: 0,
  };
}

function appendLog(state: TuiState, component: string, message: string): void {
  state.log.push({ time: new Date(), component, message });
  if (state.log.length > MAX_LOG) {
    state.log.splice(0, state.log.length - MAX_LOG);
  }
}

export function applyEvent(state: TuiState, event: ArbEvent): void {
  switch (event.type) {
    case "pass_loop_started":
      state.isRunning = true;
      state._startTime = state._startTime === 0 ? Date.now() : state._startTime;
      appendLog(state, "System", "Pass loop started");
      break;
    case "graph_built":
      state.system.poolCount = event.poolCount;
      state.system.cycleCount = event.cycleCount;
      appendLog(state, "Graph", `${event.poolCount} pools, ${event.cycleCount} cycles`);
      break;
    case "opportunity_found":
      state.metrics.opportunitiesFound++;
      state.metrics.totalProfitWei += event.profitWei;
      appendLog(state, "Pipeline", `Profit: ${event.profitWei} wei [${event.routeKey.slice(0, 10)}]`);
      break;
    case "execution_submitted":
      appendLog(state, "Exec", `Submitted [${event.routeKey.slice(0, 10)}]`);
      break;
    case "execution_result":
      state.metrics.executed++;
      if (event.success) {
        state.metrics.successful++;
        appendLog(state, "Exec", `Confirmed ${event.txHash?.slice(0, 10) ?? ""}...`);
      } else {
        state.metrics.failed++;
        appendLog(state, "Exec", `Failed: ${event.error ?? "unknown"}`);
      }
      break;
    case "gas_snapshot":
      state.system.gasPriceWei = event.gasPrice;
      break;
    case "pool_discovery":
      state.system.poolCount = event.count;
      appendLog(state, "Discovery", `${event.count} pools discovered`);
      break;
    case "error":
      appendLog(state, event.component, event.message);
      break;
    case "shutdown":
      state.isRunning = false;
      appendLog(state, "System", "Shutting down");
      break;
    case "heartbeat":
      state.system.lastCycleTimeMs = event.elapsedMs;
      appendLog(state, "heartbeat", `${event.elapsedMs}ms`);
      break;
  }
}
