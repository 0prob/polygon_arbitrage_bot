import type { ArbEvent } from "./events.ts";

export interface MetricsState {
  opportunitiesFound: number;
  executed: number;
  successful: number;
  failed: number;
  reverts: number;
  /** Cumulative realised profit in wei (MATIC). bigint to avoid fp loss. */
  totalProfitWei: bigint;
  /** Rolling profit/s computed from start time + totalProfitWei */
  profitPerSecond: number;
  totalCycles: number;
  totalErrors: number;
  /** Current rolling cycles-per-minute */
  cyclesPerMin: number;
  /** Peak cpm seen since bot start */
  peakCpm: number;
  /** Tracked routes with win-rate history */
  trackedRoutes: number;
  /** Max HF pass duration in ms */
  maxHotPathMs: number;
}

export interface SimStats {
  attempted: number;
  simulated: number;
  profitable: number;
  noRate: number;
  prunedMissingState: number;
  prunedNoGrossProfit: number;
  prunedInvalidBounds: number;
  prunedFinalCheckFailed: number;
  /** Best gross profit seen this pass (milli-MATIC) */
  maxGrossMilliMatic: number;
  durationMs: number;
  ratesCovered: number;
  cacheSize: number;
  rateSafeCycles: number;
  totalCycles: number;
  /** Timestamp of last sim */
  ts: number;
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
  /** Current gas price in Gwei as a readable number */
  gasPriceGwei: number;
  poolCount: number;
  cycleCount: number;
  lastCycleTimeMs: number;
  hiStatus: string;
  hiSyncedBlock: number;
  hiRemoteBlock: number;
  hiLag: number;
  hiSyncRate: number;
  hiChain?: string;
  hiLastSeen: number;
  poolsPerProtocol: Record<string, number>;
  maxHops: number;
  pipelineStage: "IDLE" | "DISCOVERY" | "LF_REFRESH" | "ENUMERATING" | "PRE_FETCH" | "RATES" | "SIMULATING" | "EXECUTING";
  simProgress: { current: number; total: number; profitable: number };
  /** Last simulation breakdown — null until first sim completes */
  lastSimStats: SimStats | null;
  activeOpportunities: OpportunityEntry[];
  maticPriceUsd: number;
  mempoolFeedStatus: "connected" | "disconnected" | "error" | "unknown";
  pendingSwaps: { path: string; value: string; txHash: string; timestamp: number; traceId: string }[];
  discoverySummary: { poolCount: number; protocolBreakdown: Record<string, number>; lagBlocks: number } | null;
  lastRejectReason: string | null;
  cyclesByHop: Record<number, number>;
  enumerationTimeMs: number;
  protocolBreakdown: Record<string, number>;
  edgeCount: number;
  cachedStateCount: number;
  lastExecution: { path: string; txHash: string; profit: bigint; success: boolean } | null;
  /** Profit sparkline — ring buffer of last SPARKLINE_LEN successful profits in wei */
  profitSparkline: number[];
  rpcConnected: boolean;
  hasuraConnected: boolean;
  wsConnected: boolean;
}

export interface LogEntry {
  /** Preformatted HH:MM:SS — formatting once at append time avoids per-frame Intl calls in the renderer. */
  time: string;
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

// Ring buffer size for log — kept as a power of two for mod efficiency
const MAX_LOG = 500;
const SPARKLINE_LEN = 30;

export function createInitialState(): TuiState {
  return {
    metrics: {
      opportunitiesFound: 0,
      executed: 0,
      successful: 0,
      failed: 0,
      reverts: 0,
      totalProfitWei: 0n,
      profitPerSecond: 0,
      totalCycles: 0,
      totalErrors: 0,
      cyclesPerMin: 0,
      peakCpm: 0,
      trackedRoutes: 0,
      maxHotPathMs: 0,
    },
    system: {
      gasPriceWei: 0n,
      gasPriceGwei: 0,
      poolCount: 0,
      cycleCount: 0,
      lastCycleTimeMs: 0,
      hiStatus: "starting",
      hiSyncedBlock: 0,
      hiRemoteBlock: 0,
      hiLag: 0,
      hiSyncRate: 0,
      hiLastSeen: 0,
      poolsPerProtocol: {},
      maxHops: 0,
      pipelineStage: "IDLE",
      simProgress: { current: 0, total: 0, profitable: 0 },
      lastSimStats: null,
      activeOpportunities: [],
      maticPriceUsd: 0.7,
      mempoolFeedStatus: "unknown",
      pendingSwaps: [],
      discoverySummary: null,
      lastRejectReason: null,
      cyclesByHop: {},
      enumerationTimeMs: 0,
      protocolBreakdown: {},
      edgeCount: 0,
      cachedStateCount: 0,
      lastExecution: null,
      profitSparkline: [],
      rpcConnected: false,
      hasuraConnected: false,
      wsConnected: false,
    },
    log: [],
    isRunning: false,
    isPaused: false,
    _startTime: 0,
  };
}

function formatLogTime(d: Date): string {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function appendLog(state: TuiState, component: string, message: string): void {
  state.log.push({ time: formatLogTime(new Date()), component, message });
  // Trim to MAX_LOG in one splice rather than iterating
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

  // Sort by profit descending, keep top 10
  state.system.activeOpportunities.sort((a, b) => (a.profit < b.profit ? 1 : a.profit > b.profit ? -1 : 0));
  if (state.system.activeOpportunities.length > 10) {
    state.system.activeOpportunities.length = 10;
  }
}

export function applyEvent(state: TuiState, event: ArbEvent): void {
  switch (event.type) {
    case "pipeline_stage":
      state.system.pipelineStage = event.stage;
      // Don't log every stage change — too noisy. Only log non-IDLE transitions
      // so the log panel shows meaningful pipeline activity, not constant IDLE spam.
      if (event.stage !== "IDLE") {
        appendLog(state, "Stage", event.stage);
      }
      break;

    case "simulation_progress":
      state.system.simProgress = { current: event.current, total: event.total, profitable: event.profitable };
      break;

    case "simulation_stats":
      state.system.lastSimStats = {
        attempted: event.attempted,
        simulated: event.simulated,
        profitable: event.profitable,
        noRate: event.noRate,
        prunedMissingState: event.prunedMissingState,
        prunedNoGrossProfit: event.prunedNoGrossProfit,
        prunedInvalidBounds: event.prunedInvalidBounds,
        prunedFinalCheckFailed: event.prunedFinalCheckFailed,
        maxGrossMilliMatic: event.maxGrossMilliMatic,
        durationMs: event.durationMs,
        ratesCovered: event.ratesCovered,
        cacheSize: event.cacheSize,
        rateSafeCycles: event.rateSafeCycles,
        totalCycles: event.totalCycles,
        ts: Date.now(),
      };
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
      appendLog(state, "Graph", `${event.poolCount} pools, ${event.cycleCount} cycles (max ${event.maxHops} hops)`);
      break;

    case "opportunity_found":
      state.metrics.opportunitiesFound++;
      updateOpportunity(state, event.routeKey, {
        profit: event.profitWei,
        path: event.path,
        roi: event.roi,
        status: "Simulated",
      });
      // Log only meaningful profits to reduce noise (> 0.0001 MATIC)
      if (event.profitWei > 100_000_000_000_000n) {
        const maticStr = (Number(event.profitWei) / 1e18).toFixed(6);
        appendLog(state, "Pipeline", `Profitable: ${maticStr} MATIC [${event.routeKey.slice(0, 10)}]`);
      }
      break;

    case "execution_attempt": {
      const profitStr =
        event.expectedProfit > 0n
          ? `+${(Number(event.expectedProfit) / 1e18).toFixed(6)}`
          : `${(Number(event.expectedProfit) / 1e18).toFixed(6)}`;
      appendLog(state, "Exec", `Attempt ${event.protocolPath} (${event.hopCount}-hop) ${profitStr} MATIC`);
      break;
    }

    case "execution_submitted":
      updateOpportunity(state, event.routeKey, { status: "Executing" });
      appendLog(state, "Exec", `Submitted [${event.routeKey.slice(0, 10)}]`);
      break;

    case "execution_result":
      state.metrics.executed++;
      if (event.success) {
        state.metrics.successful++;
        const profitWei = event.profitWei ?? 0n;
        state.metrics.totalProfitWei += profitWei;
        updateOpportunity(state, event.routeKey, { status: "Confirmed", profit: profitWei });
        const maticStr = (Number(profitWei) / 1e18).toFixed(6);
        appendLog(state, "Exec", `✅ Confirmed ${event.txHash?.slice(0, 10) ?? ""}… (+${maticStr} MATIC)`);
        state.system.lastRejectReason = null;
        // Push into sparkline ring buffer
        state.system.profitSparkline.push(Number(profitWei));
        if (state.system.profitSparkline.length > SPARKLINE_LEN) {
          state.system.profitSparkline.splice(0, state.system.profitSparkline.length - SPARKLINE_LEN);
        }
      } else {
        const isRevert = event.error === "reverted";
        if (isRevert) {
          state.metrics.reverts++;
        } else {
          state.metrics.failed++;
        }
        const statusLabel = event.error?.includes("quarantine") ? "Quarantined" : "Failed";
        updateOpportunity(state, event.routeKey, { status: statusLabel });
        appendLog(state, "Exec", `❌ ${isRevert ? "Reverted" : "Failed"}: ${event.error ?? "unknown"}`);
        state.system.lastRejectReason = event.error ?? "unknown";
      }

      if (event.protocolPath) {
        state.system.lastExecution = {
          path: event.protocolPath,
          txHash: event.txHash ?? "",
          profit: event.profitWei ?? 0n,
          success: event.success,
        };
      }

      // Surface trace parser insights
      if (event.traceMessages && event.traceMessages.length > 0) {
        const msgStr = event.traceMessages.join(" | ");
        const comp = event.success ? "Trace" : "TraceWarn";
        appendLog(state, comp, `${event.routeKey.slice(0, 8)}: ${msgStr}`);
      }
      break;

    case "mempool_pending_swap": {
      state.system.pendingSwaps.unshift({
        path: event.poolPath,
        value: event.value.toString(),
        txHash: event.txHash,
        timestamp: Date.now(),
        traceId: event.traceId,
      });
      if (state.system.pendingSwaps.length > 5) state.system.pendingSwaps.length = 5;
      appendLog(state, "Mempool", `[${event.traceId.slice(0, 8)}] ${event.poolPath} ${(Number(event.value) / 1e18).toFixed(4)} MATIC`);
      break;
    }

    case "discovery_summary":
      state.system.discoverySummary = {
        poolCount: event.poolCount,
        protocolBreakdown: event.protocolBreakdown,
        lagBlocks: event.lagBlocks,
      };
      break;

    case "gas_snapshot":
      state.system.gasPriceWei = event.gasPrice;
      state.system.gasPriceGwei = Number(event.gasPrice) / 1e9;
      break;

    case "pool_discovery":
      state.system.poolCount = event.count;
      appendLog(state, "Discovery", `${event.count} pools discovered`);
      break;

    case "cycles_enumerated":
      state.system.cycleCount = event.total;
      state.system.cyclesByHop = event.cyclesByHop;
      state.system.enumerationTimeMs = event.elapsedMs;
      appendLog(state, "Routing", `${event.total} cycles (${event.elapsedMs}ms)`);
      break;

    case "graph_stats":
      state.system.poolCount = event.poolCount;
      state.system.protocolBreakdown = event.protocolBreakdown;
      state.system.edgeCount = event.edgeCount;
      state.system.cachedStateCount = event.cachedCount;
      break;

    case "error":
      appendLog(state, event.component, event.message);
      break;

    case "shutdown":
      state.isRunning = false;
      appendLog(state, "System", "Shutting down");
      break;

    case "connection_status":
      if (event.subsystem === "rpc") state.system.rpcConnected = event.status === "connected";
      if (event.subsystem === "hasura") state.system.hasuraConnected = event.status === "connected";
      if (event.subsystem === "ws") {
        state.system.wsConnected = event.status === "connected";
        state.system.mempoolFeedStatus = event.status;
      }
      if (event.status === "error") appendLog(state, "Status", `${event.subsystem.toUpperCase()} error`);
      break;

    case "heartbeat":
      state.system.lastCycleTimeMs = event.elapsedMs;
      state.metrics.totalCycles = event.cycles;
      state.metrics.totalErrors = event.totalErrors;
      if (event.indexerLag !== undefined) state.system.hiLag = event.indexerLag;
      if (event.gasPrice !== undefined && event.gasPrice > 0n) {
        state.system.gasPriceWei = event.gasPrice;
        state.system.gasPriceGwei = Number(event.gasPrice) / 1e9;
      }
      if (event.rpcConnected !== undefined) state.system.rpcConnected = event.rpcConnected;
      if (event.hasuraConnected !== undefined) state.system.hasuraConnected = event.hasuraConnected;
      if (event.wsConnected !== undefined) state.system.wsConnected = event.wsConnected;
      if (event.maticPriceUsd !== undefined && event.maticPriceUsd > 0) {
        state.system.maticPriceUsd = event.maticPriceUsd;
      }
      if (event.cyclesPerMin !== undefined) state.metrics.cyclesPerMin = event.cyclesPerMin;
      if (event.peakCpm !== undefined) state.metrics.peakCpm = event.peakCpm;
      if (event.trackedRoutes !== undefined) state.metrics.trackedRoutes = event.trackedRoutes;
      if (event.maxHotPathMs !== undefined && event.maxHotPathMs > state.metrics.maxHotPathMs) {
        state.metrics.maxHotPathMs = event.maxHotPathMs;
      }
      // Compute profit/s from start time — avoids dividing large bigints
      if (state._startTime > 0) {
        const elapsedSec = (Date.now() - state._startTime) / 1000;
        // Safe: profit/s in MATIC, convert bigint->number only for display division
        state.metrics.profitPerSecond = elapsedSec > 0 ? Number(state.metrics.totalProfitWei) / 1e18 / elapsedSec : 0;
      }
      break;

    case "pause_toggled":
      state.isPaused = event.isPaused;
      break;

    case "hyperindex_status": {
      // Don't downgrade from synced/syncing to running/starting if we already have block data
      if (event.status === "running" && state.system.hiSyncedBlock > 0) break;
      if (event.status === "starting" && state.system.hiSyncedBlock > 0) break;
      const prevStatus = state.system.hiStatus;
      state.system.hiStatus = event.status;
      state.system.hiLastSeen = Date.now();
      if (event.syncedBlock > 0) state.system.hiSyncedBlock = event.syncedBlock;
      if (event.remoteBlock > 0) state.system.hiRemoteBlock = event.remoteBlock;
      if (event.lag !== undefined) state.system.hiLag = event.lag;
      if (event.syncRate !== undefined) state.system.hiSyncRate = event.syncRate;
      if (event.chain) state.system.hiChain = event.chain;

      if (event.status === "error") {
        appendLog(state, "Indexer", `ERROR — restarting`);
      } else if (event.status === "synced") {
        appendLog(state, "Indexer", `Synced at block ${event.syncedBlock}${event.lag !== undefined ? ` (lag: ${event.lag})` : ""}`);
      } else if (event.status === "syncing" && prevStatus !== "syncing") {
        appendLog(state, "Indexer", `Syncing — ${event.syncedBlock}/${event.remoteBlock}`);
      } else if (event.status === "indexer_ready") {
        appendLog(state, "Indexer", "Ready — processing events");
      } else if (event.status === "external" && prevStatus !== "external") {
        appendLog(state, "Indexer", "External mode");
      }
      break;
    }
  }
}
