import { createArbSearcher, toRouteResultLike } from "./search.ts";
import { createExecutionCoordinator } from "./execution_coordinator.ts";
import { createRouteRevalidator } from "./route_revalidation.ts";
import type { ExecutableCandidate, ArbPathLike } from "./assessment.ts";

type OpportunityEngineDeps = {
  search: Omit<Parameters<typeof createArbSearcher>[0], "filterQuarantinedCandidates">;
  execution: Parameters<typeof createExecutionCoordinator>[0];
  revalidation: Omit<Parameters<typeof createRouteRevalidator>[0], "filterQuarantinedCandidates" | "executeBatchIfIdle">;
};

export function createOpportunityEngine(deps: OpportunityEngineDeps) {
  const executionCoordinator = createExecutionCoordinator(deps.execution);
  const {
    clearExecutionRouteQuarantine,
    executeBatchIfIdle,
    filterQuarantinedCandidates,
  } = executionCoordinator;

  const searcher = createArbSearcher({
    ...deps.search,
    filterQuarantinedCandidates,
  });

  const revalidateCachedRoutes = createRouteRevalidator({
    ...deps.revalidation,
    filterQuarantinedCandidates,
    executeBatchIfIdle,
  });

  return {
    search: searcher,
    revalidateCachedRoutes,
    clearExecutionRouteQuarantine,
    executeBatchIfIdle: (candidates: ExecutableCandidate[], source?: string) =>
      executeBatchIfIdle(candidates, source),
    filterQuarantinedCandidates: <T extends { path: ArbPathLike }>(candidates: T[], source: string) =>
      filterQuarantinedCandidates(candidates, source),
    toRouteResultLike,
  };
}
