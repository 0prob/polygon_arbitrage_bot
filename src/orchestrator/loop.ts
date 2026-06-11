/**
 * Dependency injection surface for the hot execution loop (runPassLoop / PassRunner).
 *
 * This file previously contained a large dead `runPipeline()` implementation
 * (an incomplete extraction that duplicated logic in pass_loop.ts and was never called).
 * It has been removed to eliminate the redundancy and bloat.
 *
 * Only the PassLoopDeps contract remains, because it is the public API used by
 * tests and the thin runner wrapper for overriding real dependencies.
 *
 * Hasura/state-refresh functions (discoverPoolsFromHasura, buildStateCacheFromGraphQL,
 * fetchTokenMetasFromHasura, fetchIndexerProgressFromHasura) were removed from this
 * interface after StateRefreshService took ownership of all pool discovery and state
 * hydration. findCycles was also removed since pass_loop uses enumerateCycles directly.
 */
import type { buildGraph, enumerateCycles, evaluatePipeline, SwapEdge, ArbInstrumenter } from "../pipeline/index.ts";

// buildExecutionCandidate lives in services/execution — import its type only (no runtime cost)
import type { buildExecutionCandidate } from "../services/execution/candidate.ts";

export interface PassLoopDeps {
  buildGraph: typeof buildGraph;
  enumerateCycles: typeof enumerateCycles;
  evaluatePipeline: typeof evaluatePipeline;

  routeKeyFromEdges: (edges: SwapEdge[]) => string;
  buildExecutionCandidate: typeof buildExecutionCandidate;
  instrumenter: ArbInstrumenter;
}
