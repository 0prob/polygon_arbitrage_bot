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

export interface OpportunityEntry {
  routeKey: string;
  path: string;
  profit: bigint;
  roi: number;
  status: "Simulated" | "Executing" | "Confirmed" | "Failed" | "Quarantined";
  timestamp: number;
}

export interface SystemState {
  gasPriceWei: bigint;
  poolCount: number;
  cycleCount: number;
  lastCycleTimeMs: number;
  hiStatus: string;
  hiSyncedBlock: number;
  /** Indexer discovery mode: 'broad' (long-tail friendly, default) or 'hot-bias' (conservative, major tokens only) */
  hiDiscoveryMode?: "broad" | "hot-bias";
  hiRemoteBlock: number;
  hiLag: number;
  hiSyncRate: number;
  hiChain?: string;
  hiLastSeen: number;
  /** Short prefix of currently active ENVIO_API_TOKEN for the HyperIndex process (multi-key rotation) */
  hiEnvioKeyPrefix?: string;
  poolsPerProtocol: Record<string, number>;
  maxHops: number;
  pipelineStage: "IDLE" | "DISCOVERY" | "ENUMERATING" | "SIMULATING" | "EXECUTING";
  simProgress: { current: number; total: number; profitable: number };
  activeOpportunities: OpportunityEntry[];
  maticPriceUsd: number;
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
      hiDiscoveryMode: undefined,
      hiRemoteBlock: 0,
      hiLag: 0,
      hiSyncRate: 0,
      hiLastSeen: 0,
      hiEnvioKeyPrefix: undefined,
      poolsPerProtocol: {},
      maxHops: 0,
      pipelineStage: "IDLE",
      simProgress: { current: 0, total: 0, profitable: 0 },
      activeOpportunities: [],
      maticPriceUsd: 0.7,
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

function updateOpportunity(state: TuiState, routeKey: string, update: Partial<OpportunityEntry>): void {
  const existing = state.system.activeOpportunities.find((o) => o.routeKey === routeKey);
  if (existing) {
    Object.assign(existing, update);
    existing.timestamp = Date.now();
  } else {
    state.system.activeOpportunities.unshift({
      routeKey,
      path: update.path ?? routeKey.slice(0, 10) + "...",
      profit: 0n,
      roi: 0,
      status: "Simulated",
      timestamp: Date.now(),
      ...update,
    });
  }

  // Sort by profit descending and keep top 10
  state.system.activeOpportunities.sort((a, b) => (a.profit < b.profit ? 1 : a.profit > b.profit ? -1 : 0));
  if (state.system.activeOpportunities.length > 10) {
    state.system.activeOpportunities.length = 10;
  }
}

export function applyEvent(state: TuiState, event: ArbEvent): void {
  switch (event.type) {
    case "pipeline_stage":
      state.system.pipelineStage = event.stage;
      break;
    case "simulation_progress":
      state.system.simProgress = { current: event.current, total: event.total, profitable: event.profitable };
      break;
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
      // Removed repetitive graph log
      break;
    case "opportunity_found":
      state.metrics.opportunitiesFound++;
      state.metrics.totalProfitWei += event.profitWei ?? 0n;
      updateOpportunity(state, event.routeKey, {
        profit: event.profitWei,
        path: event.path,
        roi: event.roi,
        status: "Simulated",
      });
      appendLog(state, "Pipeline", `Profitable: ${event.profitWei} wei [${event.routeKey.slice(0, 10)}]`);
      break;
    case "execution_submitted":
      updateOpportunity(state, event.routeKey, { status: "Executing" });
      appendLog(state, "Exec", `Submitted [${event.routeKey.slice(0, 10)}]`);
      break;
    case "execution_result":
      state.metrics.executed++;
      if (event.success) {
        state.metrics.successful++;
        state.metrics.totalProfitWei += event.profitWei ?? 0n;
        updateOpportunity(state, event.routeKey, { status: "Confirmed", profit: event.profitWei });
        appendLog(state, "Exec", `Confirmed ${event.txHash?.slice(0, 10) ?? ""}... (+${event.profitWei ?? 0n} wei)`);
      } else {
        state.metrics.failed++;
        updateOpportunity(state, event.routeKey, { status: event.error?.includes("quarantine") ? "Quarantined" : "Failed" });
        appendLog(state, "Exec", `Failed: ${event.error ?? "unknown"}`);
      }

      // Surface useful insights from the trace parser in the TUI log
      if (event.traceMessages && event.traceMessages.length > 0) {
        const msgStr = event.traceMessages.join(" | ");
        const comp = event.success ? "Trace" : "TraceWarn";
        appendLog(state, comp, `${event.routeKey.slice(0, 8)}: ${msgStr}`);
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
      if (event.indexerLag !== undefined) {
        state.system.hiLag = event.indexerLag; // surface indexer lag in system state for TUI
      }
      if (state._startTime > 0) {
        const elapsedSec = (Date.now() - state._startTime) / 1000;
        state.metrics.profitPerSecond = elapsedSec > 0 ? Number(state.metrics.totalProfitWei) / elapsedSec : 0;
      }
      break;
    case "hyperindex_status":
      // Don't downgrade from synced/syncing to running/starting if we already have block data
      if (event.status === "running" && state.system.hiSyncedBlock > 0) break;
      if (event.status === "starting" && state.system.hiSyncedBlock > 0) break;
      state.system.hiStatus = event.status;
      state.system.hiLastSeen = Date.now();
      if (event.syncedBlock > 0) state.system.hiSyncedBlock = event.syncedBlock;
      if (event.remoteBlock > 0) state.system.hiRemoteBlock = event.remoteBlock;
      if (event.lag !== undefined) state.system.hiLag = event.lag;
      if (event.syncRate !== undefined) state.system.hiSyncRate = event.syncRate;
      if (event.chain) {
        state.system.hiChain = event.chain;
      }
      if (event.discoveryMode) {
        state.system.hiDiscoveryMode = event.discoveryMode;
      }
      if (event.envioKeyPrefix) {
        state.system.hiEnvioKeyPrefix = event.envioKeyPrefix;
      }
      break;
  }
}
