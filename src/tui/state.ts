import type { ArbEvent } from "./events.ts";

export interface MetricsState {
  opportunitiesFound: number;
  executed: number;
  successful: number;
  failed: number;
  totalProfitWei: bigint;
  profitPerSecond: number;
  totalCycles: number;
  totalErrors: number;
}

export interface SystemState {
  gasPriceWei: bigint;
  poolCount: number;
  cycleCount: number;
  lastCycleTimeMs: number;
  hiStatus: string;
  hiSyncedBlock: number;
  hiRemoteBlock: number;
  hiChain?: string;
  poolsPerProtocol: Record<string, number>;
  maxHops: number;
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
      profitPerSecond: 0,
      totalCycles: 0,
      totalErrors: 0,
    },
    system: {
      gasPriceWei: 0n,
      poolCount: 0,
      cycleCount: 0,
      lastCycleTimeMs: 0,
      hiStatus: "starting",
      hiSyncedBlock: 0,
      hiRemoteBlock: 0,
      poolsPerProtocol: {},
      maxHops: 0,
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
      state.system.poolsPerProtocol = event.poolsPerProtocol ?? {};
      state.system.maxHops = event.maxHops;
      appendLog(state, "Graph", `${event.poolCount} pools, ${event.cycleCount} cycles`);
      break;
    case "opportunity_found":
      state.metrics.opportunitiesFound++;
      state.metrics.totalProfitWei += event.profitWei;
      if (state._startTime > 0) {
        const elapsedSec = (Date.now() - state._startTime) / 1000;
        state.metrics.profitPerSecond = elapsedSec > 0 ? Number(state.metrics.totalProfitWei) / elapsedSec : 0;
      }
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
      state.metrics.totalCycles = event.cycles;
      state.metrics.totalErrors = event.totalErrors;
      if (state._startTime > 0) {
        const elapsedSec = (Date.now() - state._startTime) / 1000;
        state.metrics.profitPerSecond = elapsedSec > 0 ? Number(state.metrics.totalProfitWei) / elapsedSec : 0;
      }
      break;
    case "hyperindex_status":
      state.system.hiStatus = event.status;
      state.system.hiSyncedBlock = event.syncedBlock;
      state.system.hiRemoteBlock = event.remoteBlock;
      if (event.chain) {
        state.system.hiChain = event.chain;
      }
      break;
  }
}
