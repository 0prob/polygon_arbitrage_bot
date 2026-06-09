export type ArbEvent =
  | { type: "pass_loop_started"; intervalMs: number }
  | { type: "graph_built"; poolCount: number; cycleCount: number; poolsPerProtocol?: Record<string, number>; maxHops: number }
  | { type: "opportunity_found"; routeKey: string; profitWei: bigint; path: string; roi: number }
  | { type: "execution_submitted"; routeKey: string; txHash?: string }
  | {
      type: "execution_result";
      routeKey: string;
      success: boolean;
      txHash?: string;
      error?: string;
      profitWei?: bigint;
      traceMessages?: string[];
      protocolPath?: string;
      hopCount?: number;
    }
  | { type: "gas_snapshot"; gasPrice: bigint }
  | { type: "pool_discovery"; count: number; protocols?: Record<string, number> }
  | { type: "discovery_summary"; poolCount: number; protocolBreakdown: Record<string, number>; lagBlocks: number }
  | { type: "error"; component: string; message: string }
  | { type: "shutdown" }
  | {
      type: "heartbeat";
      elapsedMs: number;
      cycles: number;
      totalErrors: number;
      indexerLag?: number;
      gasPrice?: bigint;
      rpcConnected?: boolean;
      hasuraConnected?: boolean;
      wsConnected?: boolean;
      maticPriceUsd?: number;
      /** Cycles per minute (current rolling window) */
      cyclesPerMin?: number;
      /** Peak cycles per minute observed */
      peakCpm?: number;
      /** Overall execution success rate 0-100 */
      successRate?: number;
      /** Max HF cycle duration seen */
      maxHotPathMs?: number;
      /** Tracked routes with win-rate data */
      trackedRoutes?: number;
    }
  | {
      type: "hyperindex_status";
      status: string;
      syncedBlock: number;
      remoteBlock: number;
      chain?: string;
      lag?: number;
      syncRate?: number;
    }
  | {
      type: "pipeline_stage";
      stage: "IDLE" | "DISCOVERY" | "LF_REFRESH" | "ENUMERATING" | "PRE_FETCH" | "RATES" | "SIMULATING" | "EXECUTING";
    }
  | { type: "simulation_progress"; current: number; total: number; profitable: number }
  | {
      /** Emitted once per pass after simulation completes — full breakdown for debugging */
      type: "simulation_stats";
      attempted: number;
      simulated: number;
      profitable: number;
      noRate: number;
      prunedMissingState: number;
      prunedNoGrossProfit: number;
      prunedInvalidBounds: number;
      prunedFinalCheckFailed: number;
      /** Max gross profit in mMATIC this pass */
      maxGrossMilliMatic: number;
      durationMs: number;
      ratesCovered: number;
      cacheSize: number;
      /** Were cycles rate-safe before sim? */
      rateSafeCycles: number;
      totalCycles: number;
    }
  | { type: "mempool_pending_swap"; poolPath: string; value: bigint; txHash: string; traceId: string }
  | { type: "cycles_enumerated"; total: number; cyclesByHop: Record<number, number>; elapsedMs: number }
  | { type: "graph_stats"; poolCount: number; protocolBreakdown: Record<string, number>; edgeCount: number; cachedCount: number }
  | { type: "execution_attempt"; protocolPath: string; hopCount: number; expectedProfit: bigint; txHash?: string }
  | { type: "connection_status"; subsystem: string; status: "connected" | "disconnected" | "error" }
  | { type: "pause_toggled"; isPaused: boolean };

type EventHandler = (event: ArbEvent) => void;

export class EventBus {
  private handlers = new Set<EventHandler>();

  on(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  emit(event: ArbEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // swallow handler errors so one bad handler doesn't kill the bus
      }
    }
  }
}
