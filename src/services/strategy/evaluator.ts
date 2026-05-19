import { simulateRoute } from "./simulator.ts";
import type { RouteSimulationResult, RouteStateCache } from "../../core/types/route.ts";
import type { FoundCycle } from "./finder.ts";

export interface EvaluatedRoute {
  path: FoundCycle;
  result: RouteSimulationResult;
}

/** Evaluate a list of cycles sequentially. Silent error handling. */
export function evaluatePaths(paths: FoundCycle[], stateCache: RouteStateCache, testAmount: bigint): EvaluatedRoute[] {
  const results: EvaluatedRoute[] = [];
  for (const path of paths) {
    try {
      const result = simulateRoute(path.edges, testAmount, stateCache);
      results.push({ path, result });
    } catch {
      continue;
    }
  }
  return results;
}

/** Evaluate cycles in parallel chunks with bounded concurrency. */
export async function evaluatePathsParallel(
  paths: FoundCycle[],
  stateCache: RouteStateCache,
  testAmount: bigint,
  concurrency = 4,
): Promise<EvaluatedRoute[]> {
  const results: EvaluatedRoute[] = [];
  for (let i = 0; i < paths.length; i += concurrency) {
    const chunk = paths.slice(i, i + concurrency);
    const chunkResults = await Promise.all(
      chunk.map((p) => {
        try {
          return Promise.resolve({ path: p, result: simulateRoute(p.edges, testAmount, stateCache) } as EvaluatedRoute);
        } catch {
          return Promise.resolve(null);
        }
      }),
    );
    for (const r of chunkResults) {
      if (r) results.push(r);
    }
  }
  return results;
}
