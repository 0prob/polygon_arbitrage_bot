import type { RuntimeContext } from "./boot.ts";
import type { PoolMeta } from "../core/types/pool.ts";
import type { RouteStateCache } from "../core/types/route.ts";
import type { EventBus } from "../tui/events.ts";
import { computeMaticRates } from "../pipeline/index.ts";

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
  let rates = cachedRates;
  let needFull = ratesNeedFullRefresh;
  let focus = pendingFocusTokens;

  if (needFull) {
    rates = computeMaticRates(hasuraPoolsCache ?? [], stateCache, ctx.logger, {
      minLiquidityV3: ctx.config.execution.minLiquidityV3Rate,
      seedRates: rates ?? undefined,
    });
    needFull = false;
  } else if (focus && rates) {
    rates = computeMaticRates(hasuraPoolsCache ?? [], stateCache, ctx.logger, {
      minLiquidityV3: ctx.config.execution.minLiquidityV3Rate,
      seedRates: rates,
      focusTokens: focus,
    });
    focus = null;
  } else if (!rates) {
    rates = computeMaticRates(hasuraPoolsCache ?? [], stateCache, ctx.logger, {
      minLiquidityV3: ctx.config.execution.minLiquidityV3Rate,
    });
  }
  if (cycleTokens.size > 0 && rates) {
    const boosted = computeMaticRates(hasuraPoolsCache ?? [], stateCache, ctx.logger, {
      minLiquidityV3: ctx.config.execution.minLiquidityV3Rate,
      seedRates: rates,
      focusTokens: cycleTokens,
    });
    rates = boosted;
  }

  const tokenToMaticRates = rates!;

  return {
    cachedRates: rates,
    tokenToMaticRates,
    ratesNeedFullRefresh: needFull,
    pendingFocusTokens: focus,
  };
}
