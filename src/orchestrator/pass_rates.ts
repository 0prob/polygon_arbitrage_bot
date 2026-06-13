import type { RuntimeContext } from "./boot.ts";
import type { PoolMeta } from "../core/types/pool.ts";
import type { RouteStateCache } from "../core/types/route.ts";
import type { EventBus } from "../tui/events.ts";
import { computeMaticRates } from "../pipeline/index.ts";
import { logSampled, METRICS_INTERVAL, summarizeTokenRates } from "../infra/observability/metrics.ts";

export function runRateComputation(
  ctx: RuntimeContext,
  hasuraPoolsCache: PoolMeta[] | null,
  stateCache: RouteStateCache,
  cachedRates: Map<string, bigint> | null,
  ratesNeedFullRefresh: boolean,
  pendingFocusTokens: Set<string> | null,
  cycleTokens: Set<string>,
  bus?: EventBus,
): {
  cachedRates: Map<string, bigint>;
  tokenToMaticRates: Map<string, bigint>;
  ratesNeedFullRefresh: boolean;
  pendingFocusTokens: Set<string> | null;
} {
  bus?.emit({ type: "pipeline_stage", stage: "RATES" });

  const focus = new Set<string>();
  if (pendingFocusTokens) {
    for (const t of pendingFocusTokens) focus.add(t);
  }
  if (cycleTokens.size > 0) {
    for (const t of cycleTokens) focus.add(t);
  }

  let rates = cachedRates;
  let needFull = ratesNeedFullRefresh;

  const shouldCompute = needFull || !rates || focus.size > 0;
  if (shouldCompute) {
    rates = computeMaticRates(hasuraPoolsCache ?? [], stateCache, ctx.logger, {
      minLiquidityV3: ctx.config.execution.minLiquidityV3Rate,
      seedRates: rates ?? undefined,
      focusTokens: focus.size > 0 ? focus : undefined,
    });
    needFull = false;
  }

  const tokenToMaticRates = rates!;

  if (hasuraPoolsCache && hasuraPoolsCache.length > 0) {
    logSampled(
      ctx.logger,
      "rates:coverage",
      "debug",
      "Token rate coverage",
      summarizeTokenRates(hasuraPoolsCache, tokenToMaticRates),
      METRICS_INTERVAL.tokenRates,
    );
  }

  return {
    cachedRates: rates,
    tokenToMaticRates,
    ratesNeedFullRefresh: needFull,
    pendingFocusTokens: null,
  };
}
