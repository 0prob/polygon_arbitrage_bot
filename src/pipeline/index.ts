export {
  type SwapEdge,
  type RoutingGraph,
  type FoundCycle,
  type SimulationEdge,
  type PipelineOptions,
  type PipelineResult,
  type StateSnapshot,
  DEFAULT_FEE_BPS,
} from "./types.ts";
export { buildGraph, createEdgesForPool } from "./graph.ts";
export {
  findCycles,
  enumerateCycles,
  routeKeyFromEdges,
  getObscurityBonus,
  averageObscurity,
  getDynamicSearchBounds,
} from "./finder.ts";
export {
  simulateRoute,
  simulateRouteMinimal,
  buildSimulationEdges,
  simulateHop,
  getTestAmount,
} from "./simulator.ts";
export { fetchMissingPoolState, pruneFailedPools } from "./fetcher.ts"; // returns Set of updated pool addresses
export { computeMaticRates, type ComputeMaticRatesOptions } from "./rates.ts";
export { evaluatePipeline } from "./pipeline.ts";
export { ArbInstrumenter, type SimulationTrace, type ExecutionComparison } from "./instrumenter.ts";

// Recently relocated modules (moved out of the old services/strategy/ legacy facade)
export { IncrementalGraphUpdater } from "./graph_incremental.ts";
