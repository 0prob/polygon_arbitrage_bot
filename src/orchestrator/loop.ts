/**
 * Dependency injection surface for the hot execution loop (runPassLoop / PassRunner).
 *
 * This file previously contained a large dead `runPipeline()` implementation
 * (an incomplete extraction that duplicated logic in pass_loop.ts and was never called).
 * It has been removed to eliminate the redundancy and bloat.
 *
 * Only the PassLoopDeps contract remains, because it is the public API used by
 * tests and the thin runner wrapper for overriding real dependencies.
 */
import type { buildGraph, findCycles, enumerateCycles, evaluatePipeline, SwapEdge, ArbInstrumenter } from "../pipeline/index.ts";
import type { Address } from "../core/types/common.ts";

// buildExecutionCandidate lives in services/execution — import its type only (no runtime cost)
import type { buildExecutionCandidate } from "../services/execution/candidate.ts";

// Pull the exact function types for the three hypersync helpers from their real source (type-only import — zero runtime cost)
import type {
  discoverPoolsFromHasura,
  buildStateCacheFromGraphQL,
  fetchTokenMetasFromHasura,
  fetchIndexerProgressFromHasura,
} from "../infra/hypersync/hyperindex_graphql.ts";

// Re-export the real function types so PassLoopDeps stays accurate and free of `any`.
export interface PassLoopDeps {
  buildGraph: typeof buildGraph;
  findCycles: typeof findCycles;
  enumerateCycles: typeof enumerateCycles;
  evaluatePipeline: typeof evaluatePipeline;
  discoverPoolsFromHasura: typeof discoverPoolsFromHasura;
  buildStateCacheFromGraphQL: typeof buildStateCacheFromGraphQL;
  fetchTokenMetasFromHasura: typeof fetchTokenMetasFromHasura;
  fetchIndexerProgressFromHasura: typeof fetchIndexerProgressFromHasura;
  averageObscurity?: (edges: SwapEdge[]) => number; // optional for long-tail risk relaxation (uses SwapEdge from pipeline)
  routeKeyFromEdges: (edges: SwapEdge[]) => string;
  buildExecutionCandidate: typeof buildExecutionCandidate;
  instrumenter: ArbInstrumenter;
}
