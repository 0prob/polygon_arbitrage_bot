import type {
  buildGraph,
  enumerateCycles,
  evaluatePipeline,
  findCyclesMultiPass,
  findCyclesBellmanFordMultiPass,
  finalizeEnumeratedCycles,
  SwapEdge,
  ArbInstrumenter,
  RoutingGraph,
  FoundCycle,
  CycleSearchPass,
} from "../pipeline/index.ts";
import type { buildExecutionCandidate } from "../services/execution/candidate.ts";

export interface PassLoopDeps {
  buildGraph: typeof buildGraph;
  enumerateCycles: typeof enumerateCycles;
  evaluatePipeline: typeof evaluatePipeline;
  /** LF multi-pass raw enumeration (defaults to pipeline findCyclesMultiPass). */
  findCyclesMultiPass?: (
    graph: RoutingGraph,
    passes: CycleSearchPass[],
    logger?: { warn?: (obj: Record<string, unknown>, msg?: string) => void },
  ) => Promise<FoundCycle[]>;
  findCyclesBellmanFordMultiPass?: (
    graph: RoutingGraph,
    passes: CycleSearchPass[],
  ) => Promise<FoundCycle[]>;
  finalizeEnumeratedCycles?: typeof finalizeEnumeratedCycles;

  routeKeyFromEdges: (edges: SwapEdge[]) => string;
  buildExecutionCandidate: typeof buildExecutionCandidate;
  instrumenter: ArbInstrumenter;
}
