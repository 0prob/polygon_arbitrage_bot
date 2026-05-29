export type ArbEvent =
  | { type: "pass_loop_started"; intervalMs: number }
  | { type: "graph_built"; poolCount: number; cycleCount: number; poolsPerProtocol?: Record<string, number>; maxHops: number }
  | { type: "opportunity_found"; routeKey: string; profitWei: bigint; path: string; roi: number }
  | { type: "execution_submitted"; routeKey: string; txHash?: string }
  | { type: "execution_result"; routeKey: string; success: boolean; txHash?: string; error?: string; profitWei?: bigint; traceMessages?: string[] }
  | { type: "gas_snapshot"; gasPrice: bigint }
  | { type: "pool_discovery"; count: number }
  | { type: "error"; component: string; message: string }
  | { type: "shutdown" }
  | { type: "heartbeat"; elapsedMs: number; cycles: number; totalErrors: number }
  | { type: "hyperindex_status"; status: string; syncedBlock: number; remoteBlock: number; chain?: string; lag?: number; syncRate?: number; discoveryMode?: 'broad' | 'hot-bias' }
  | { type: "pipeline_stage"; stage: "IDLE" | "DISCOVERY" | "ENUMERATING" | "SIMULATING" | "EXECUTING" }
  | { type: "simulation_progress"; current: number; total: number; profitable: number };

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
      } catch (_err: unknown) {
        // swallow handler errors so one bad handler doesn't kill the bus
      }
    }
  }
}
