import type { BotState } from "../tui/types.ts";

export type OperatorLogMeta = Record<string, unknown>;
export type OperatorLogMetaInput = OperatorLogMeta | (() => OperatorLogMeta) | unknown;
type OperatorLogState = Pick<BotState, "logs"> &
  Partial<Pick<BotState, "currentActivity" | "currentActivityDetail" | "currentActivityUpdatedMs" | "currentActivityProgress">> & {
    lastRoutingUniverseMeta?: OperatorLogMeta;
  };

const ACTIVITY_BY_EVENT: Record<string, string> = {
  pass_start: "Starting pass",
  pass_opportunities: "Checking opportunities",
  pass_execute_best: "Executing opportunities",
  pass_complete: "Pass complete",
  pass_failed: "Pass failed",
  cycle_refresh_start: "Refreshing routes",
  routing_universe: "Preparing routing universe",
  route_cycle_cache_hit: "Loaded route cycle cache",
  route_cycle_cache_unusable: "Rebuilding route cycles",
  route_cycle_cache_expired: "Rebuilding route cycles",
  route_cycle_enumeration_start: "Enumerating route cycles",
  route_cycle_finalize: "Finalizing route refresh",
  route_cycle_cache_store: "Storing route cycle cache",
  cycle_refresh_complete: "Routing refresh complete",
  scan_prune_routes: "Pruning stale routes",
  scan_evaluation_start: "Simulating routes",
  multi_probe_summary: "Route simulation complete",
  scan_summary: "Routing scan complete",
  scan_skip_no_fresh_routes: "No fresh routes",
  scan_skip_stale_gas: "Waiting for gas data",
  quiet_pool_sweep_start: "Hydrating quiet pools",
  quiet_pool_sweep_complete: "Quiet-pool hydration complete",
  quiet_pool_sweep_fetch_failed: "Quiet-pool hydration failed",
  quiet_pool_sweep_error: "Quiet-pool hydration error",
  quiet_pool_sweep_skipped: "Quiet-pool hydration skipped",
  resource_guard_skip: "Resource guard active",
  pending_tx_touched_pools: "Pending tx touched pools",
  pending_state_refresh: "Refreshing pending pool state",
  pending_state_refresh_error: "Pending pool refresh failed",
  pending_tx_watcher_disabled: "Pending tx watcher disabled",
  pending_tx_watcher_start: "Pending tx watcher started",
  pending_tx_watcher_stop: "Pending tx watcher stopped",
  pending_tx_ws_error: "Pending tx watcher error",
  block_ws_error: "Block watcher error",
  ws_block: "Pending block observed",
  candidate_optimization_start: "Optimizing candidates",
  candidate_optimization_summary: "Candidate optimization complete",
  profitable_route: "Profitable route found",
  execute_quarantine_add: "Route quarantined",
  execute_error: "Execution failed",
  execute_bundle: "Executing bundle",
  execute_skip: "Execution skipped",
  route_cache_evict_execution_failed: "Route cache evicted",
};

function cleanText(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function finiteCount(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  return Math.max(0, Math.trunc(numeric));
}

function displayCount(value: unknown) {
  return finiteCount(value);
}

function pushDisplayCount(parts: string[], label: string, value: unknown) {
  const count = displayCount(value);
  if (count != null) parts.push(`${label}=${count}`);
  return count;
}

function displayBooleanFlag(value: unknown) {
  return typeof value === "boolean" ? (value ? 1 : 0) : undefined;
}

function pushDisplayBooleanFlag(parts: string[], label: string, value: unknown) {
  const flag = displayBooleanFlag(value);
  if (flag != null) parts.push(`${label}=${flag}`);
  return flag;
}

function displayBasisPoints(value: unknown) {
  const bps = finiteCount(value);
  return bps == null ? undefined : Math.min(10_000, bps);
}

function normalizeActivityProgress(payload: OperatorLogMeta | undefined) {
  if (!payload) return null;
  const rawProgress = payload.progress;
  const progress =
    rawProgress && typeof rawProgress === "object" && !Array.isArray(rawProgress) ? (rawProgress as Record<string, unknown>) : {};
  const completed = finiteCount(payload.progressCompleted ?? progress.completed);
  const total = finiteCount(payload.progressTotal ?? progress.total);
  const unit = cleanText(payload.progressUnit ?? progress.unit) ?? undefined;
  const label = cleanText(payload.progressLabel ?? progress.label) ?? undefined;
  if (completed == null && total == null && unit == null && label == null) return null;
  return { completed, total, unit, label };
}

function summarizeActivityProgress(payload: OperatorLogMeta | undefined) {
  const progress = normalizeActivityProgress(payload);
  if (!progress) return null;
  const parts: string[] = [];
  if (progress.label) parts.push(progress.label);
  if (progress.completed != null && progress.total != null) {
    parts.push(`${progress.completed}/${progress.total}`);
  } else if (progress.completed != null) {
    parts.push(String(progress.completed));
  } else if (progress.total != null) {
    parts.push(`0/${progress.total}`);
  }
  if (progress.unit) parts.push(progress.unit);
  return parts.join(":");
}

function recordValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function recordObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function errorReason(value: unknown) {
  if (value instanceof Error) return cleanText(value.message);
  const text = cleanText(value);
  if (text) return text;
  const record = recordObject(value);
  return cleanText(record?.message) ?? cleanText(record?.shortMessage) ?? cleanText(record?.reason) ?? cleanText(record?.details);
}

function quietPoolFetchFailureReason(value: unknown) {
  const reason = cleanText(value);
  const prefix = "quiet_pool_sweep_fetch_failed:";
  if (reason?.startsWith(prefix)) return cleanText(reason.slice(prefix.length)) ?? reason;
  return reason;
}

function countSummary(value: unknown, labelKey: string, limit = 3) {
  if (!Array.isArray(value)) return null;
  const parts = value
    .map((entry) => {
      const record = recordObject(entry);
      if (!record) return null;
      const label = cleanText(record[labelKey]);
      const pools = finiteCount(record.pools);
      return label && pools != null && pools > 0 ? `${label}:${pools}` : null;
    })
    .filter((entry): entry is string => Boolean(entry))
    .slice(0, limit);
  return parts.length > 0 ? parts.join(",") : null;
}

function protocolCountSummary(value: unknown, limit = 3) {
  return countSummary(value, "protocol", limit);
}

function protocolCountTopSummary(value: unknown, limit = 3) {
  if (!Array.isArray(value)) return null;
  const aggregated = Array.from(protocolCountMap(value), ([protocol, pools]) => ({ protocol, pools }));
  return countSummary(
    aggregated.sort((a, b) => {
      const poolDelta = b.pools - a.pools;
      if (poolDelta !== 0) return poolDelta;
      return a.protocol.localeCompare(b.protocol);
    }),
    "protocol",
    limit,
  );
}

function hubClassSortRank(hubClass: string | null) {
  if (hubClass === "core_hub") return 0;
  if (hubClass === "polygon_hub") return 1;
  if (hubClass === "non_hub") return 2;
  return 3;
}

function hubClassCountSummary(value: unknown, limit = 3) {
  if (!Array.isArray(value)) return null;
  return countSummary(
    [...value].sort((a, b) => {
      const left = recordObject(a);
      const right = recordObject(b);
      const poolDelta = (finiteCount(right?.pools) ?? 0) - (finiteCount(left?.pools) ?? 0);
      if (poolDelta !== 0) return poolDelta;
      const leftHubClass = cleanText(left?.hubClass);
      const rightHubClass = cleanText(right?.hubClass);
      const rankDelta = hubClassSortRank(leftHubClass) - hubClassSortRank(rightHubClass);
      if (rankDelta !== 0) return rankDelta;
      return (leftHubClass ?? "").localeCompare(rightHubClass ?? "");
    }),
    "hubClass",
    limit,
  );
}

function yieldSummary(value: unknown, labelKey: string, limit = 3) {
  if (!Array.isArray(value)) return null;
  const groups = new Map<string, { label: string; selectedPools: number; routablePools: number }>();
  for (const entry of value) {
    const record = recordObject(entry);
    if (!record) continue;
    const label = cleanText(record[labelKey]);
    const selectedPools = finiteCount(record.selectedPools);
    const routablePools = finiteCount(record.routablePools);
    if (!label || selectedPools == null || selectedPools <= 0 || routablePools == null) continue;
    const group = groups.get(label) ?? { label, selectedPools: 0, routablePools: 0 };
    group.selectedPools += selectedPools;
    group.routablePools += routablePools;
    groups.set(label, group);
  }
  const entries = Array.from(groups.values())
    .map((entry) => {
      const routablePools = Math.min(entry.routablePools, entry.selectedPools);
      const routableRateBps = Math.min(10_000, Math.floor((routablePools * 10_000) / entry.selectedPools));
      return { ...entry, routablePools, routableRateBps };
    })
    .sort((a, b) => a.routableRateBps - b.routableRateBps || b.selectedPools - a.selectedPools || a.label.localeCompare(b.label));
  const parts = entries
    .slice(0, limit)
    .map((entry) => `${entry.label}:${entry.routablePools}/${entry.selectedPools}@${entry.routableRateBps}`);
  return parts.length > 0 ? parts.join(",") : null;
}

function protocolCohortCooldownSummary(value: unknown) {
  if (!Array.isArray(value)) return null;
  const top = value
    .map((entry) => {
      const record = recordObject(entry);
      const protocol = cleanText(record?.protocol);
      const selectedPools = finiteCount(record?.selectedPools);
      const failedPools = finiteCount(record?.failedPools);
      return protocol && selectedPools != null && selectedPools > 0 && failedPools != null
        ? { protocol, selectedPools, failedPools }
        : null;
    })
    .filter((entry): entry is { protocol: string; selectedPools: number; failedPools: number } => Boolean(entry))
    .sort((a, b) => b.selectedPools - a.selectedPools || b.failedPools - a.failedPools || a.protocol.localeCompare(b.protocol))[0];
  return top ? `${top.protocol}:${top.selectedPools}/${top.failedPools}` : null;
}

function coverageGapRows(value: unknown) {
  if (!Array.isArray(value)) return [];
  const groups = new Map<
    string,
    {
      protocol: string;
      rows: number;
      activePools: number;
      stateRows: number;
      missingStatePools: number;
      stateCoverageBps: number;
      routablePools: number;
      routableCoverageBps: number;
    }
  >();
  for (const entry of value) {
    const record = recordObject(entry);
    if (!record) continue;
    const protocol = cleanText(record.protocol);
    const activePools = displayCount(record.activePools);
    const stateRows = displayCount(record.stateRows);
    const missingStatePools = displayCount(record.missingStatePools);
    const stateCoverageBps = displayBasisPoints(record.stateCoverageBps);
    const routablePools = displayCount(record.routablePools);
    const routableCoverageBps = displayBasisPoints(record.routableCoverageBps);
    if (
      !protocol ||
      activePools == null ||
      stateRows == null ||
      missingStatePools == null ||
      stateCoverageBps == null ||
      routablePools == null ||
      routableCoverageBps == null
    )
      continue;
    const group = groups.get(protocol) ?? {
      protocol,
      rows: 0,
      activePools: 0,
      stateRows: 0,
      missingStatePools: 0,
      stateCoverageBps,
      routablePools: 0,
      routableCoverageBps,
    };
    group.rows += 1;
    group.activePools += activePools;
    group.stateRows += stateRows;
    group.missingStatePools += missingStatePools;
    group.routablePools += routablePools;
    group.stateCoverageBps =
      group.rows > 1 && group.activePools > 0
        ? (displayBasisPoints(Math.floor((group.stateRows * 10_000) / group.activePools)) ?? 0)
        : stateCoverageBps;
    group.routableCoverageBps =
      group.rows > 1 && group.activePools > 0
        ? (displayBasisPoints(Math.floor((group.routablePools * 10_000) / group.activePools)) ?? 0)
        : routableCoverageBps;
    groups.set(protocol, group);
  }
  return Array.from(groups.values()).map((entry) => ({
    ...entry,
    missingStatePools: Math.min(entry.missingStatePools, entry.activePools),
    routablePools: Math.min(entry.routablePools, entry.activePools),
  }));
}

function stateCoverageGapSummary(value: unknown, limit = 3) {
  const entries = coverageGapRows(value).sort(
    (a, b) => b.missingStatePools - a.missingStatePools || a.stateCoverageBps - b.stateCoverageBps || a.protocol.localeCompare(b.protocol),
  );
  const parts = entries
    .slice(0, limit)
    .map((entry) => `${entry.protocol}:${entry.missingStatePools}/${entry.activePools}@${entry.stateCoverageBps}`);
  return parts.length > 0 ? parts.join(",") : null;
}

function routableCoverageGapSummary(value: unknown, limit = 3) {
  const entries = coverageGapRows(value).sort(
    (a, b) => a.routableCoverageBps - b.routableCoverageBps || b.activePools - a.activePools || a.protocol.localeCompare(b.protocol),
  );
  const parts = entries
    .slice(0, limit)
    .map((entry) => `${entry.protocol}:${entry.routablePools}/${entry.activePools}@${entry.routableCoverageBps}`);
  return parts.length > 0 ? parts.join(",") : null;
}

function stateYieldSummary(value: unknown, limit = 3) {
  const entries = coverageGapRows(value)
    .map((entry) => {
      if (entry.stateRows <= 0) return null;
      const routablePools = Math.min(entry.routablePools, entry.stateRows);
      const routableStateYieldBps = Math.min(10_000, Math.floor((routablePools * 10_000) / entry.stateRows));
      return { protocol: entry.protocol, routablePools, stateRows: entry.stateRows, routableStateYieldBps };
    })
    .filter(
      (
        entry,
      ): entry is {
        protocol: string;
        routablePools: number;
        stateRows: number;
        routableStateYieldBps: number;
      } => Boolean(entry),
    )
    .sort((a, b) => a.routableStateYieldBps - b.routableStateYieldBps || b.stateRows - a.stateRows || a.protocol.localeCompare(b.protocol));
  const parts = entries
    .slice(0, limit)
    .map((entry) => `${entry.protocol}:${entry.routablePools}/${entry.stateRows}@${entry.routableStateYieldBps}`);
  return parts.length > 0 ? parts.join(",") : null;
}

function pendingReasonSummary(value: unknown, limit = 3, sortByPools = false) {
  if (!Array.isArray(value)) return null;
  const entries = value
    .map((entry) => {
      const record = recordObject(entry);
      if (!record) return null;
      const protocol = cleanText(record.protocol);
      const hubClass = cleanText(record.hubClass);
      const reason = cleanText(record.reason);
      const pools = finiteCount(record.pools);
      return protocol && hubClass && reason && pools != null && pools > 0 ? { protocol, hubClass, reason, pools } : null;
    })
    .filter((entry): entry is { protocol: string; hubClass: string; reason: string; pools: number } => Boolean(entry));
  if (sortByPools) {
    entries.sort(
      (a, b) =>
        b.pools - a.pools || [a.protocol, a.hubClass, a.reason].join("/").localeCompare([b.protocol, b.hubClass, b.reason].join("/")),
    );
  }
  const parts = entries.slice(0, limit).map((entry) => `${entry.protocol}/${entry.hubClass}:${entry.reason}:${entry.pools}`);
  return parts.length > 0 ? parts.join(",") : null;
}

function topRejectSummary(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const [reason, count] =
    Object.entries(value as Record<string, unknown>)
      .map(([entryReason, entryCount]) => [entryReason, finiteCount(entryCount)] as const)
      .filter((entry): entry is readonly [string, number] => entry[1] != null && entry[1] > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? [];
  return reason && typeof count === "number" ? `${reason}:${count}` : null;
}

function protocolCountMap(value: unknown) {
  const counts = new Map<string, number>();
  if (!Array.isArray(value)) return counts;
  for (const entry of value) {
    const record = recordObject(entry);
    if (!record) continue;
    const protocol = cleanText(record.protocol);
    const pools = finiteCount(record.pools);
    if (protocol && pools != null && pools > 0) counts.set(protocol, (counts.get(protocol) ?? 0) + pools);
  }
  return counts;
}

function protocolYieldMap(value: unknown) {
  const counts = new Map<string, { selectedPools: number; routablePools: number }>();
  if (!Array.isArray(value)) return counts;
  for (const entry of value) {
    const record = recordObject(entry);
    if (!record) continue;
    const protocol = cleanText(record.protocol);
    const selectedPools = finiteCount(record.selectedPools);
    const routablePools = finiteCount(record.routablePools);
    if (protocol && selectedPools != null && selectedPools > 0 && routablePools != null) {
      const current = counts.get(protocol) ?? { selectedPools: 0, routablePools: 0 };
      current.selectedPools += selectedPools;
      current.routablePools += routablePools;
      counts.set(protocol, current);
    }
  }
  for (const entry of counts.values()) {
    entry.routablePools = Math.min(entry.routablePools, entry.selectedPools);
  }
  return counts;
}

function hub4HydrationSelectionGap(
  pendingCoreHubPools: number,
  selectedCoreHubPools: number,
  selectedPools: number,
  routablePools: number,
  observedUnroutableCoreHubPools: number,
  event: string | null,
  hasSuppressedCoreHubPools = false,
) {
  if (event === "quiet_pool_sweep_fetch_failed" && selectedCoreHubPools > 0) return "fetch_failed";
  if (pendingCoreHubPools <= 0 && !hasSuppressedCoreHubPools) return "not_pending";
  if (selectedCoreHubPools <= 0) return "not_selected";
  if (event === "quiet_pool_sweep_complete" && selectedPools > 0 && routablePools <= 0 && observedUnroutableCoreHubPools > 0) {
    return "observed_unroutable";
  }
  if (event === "quiet_pool_sweep_complete" && selectedPools > 0 && routablePools <= 0) return "zero_yield";
  return undefined;
}

function coreHubCooldownDetailForProtocol(payload: OperatorLogMeta | undefined, protocol: string) {
  if (!Array.isArray(payload?.cooldownReasonBreakdown)) return undefined;
  let best: { reason: string | undefined; pools: number } | undefined;
  for (const entry of payload.cooldownReasonBreakdown) {
    const record = recordObject(entry);
    if (!record) continue;
    if (cleanText(record.protocol) !== protocol) continue;
    if (cleanText(record.hubClass) !== "core_hub") continue;
    const pools = finiteCount(record.pools);
    if (pools == null || pools <= 0) continue;
    const reason = cleanText(record.reason) ?? undefined;
    if (!best || pools > best.pools || (pools === best.pools && (reason || "").localeCompare(best.reason || "") < 0)) {
      best = { reason, pools };
    }
  }
  if (!best) return undefined;
  return best.reason ? `cooldown:${best.reason}` : "cooldown";
}

function hasCoreHubInFlightForProtocol(payload: OperatorLogMeta | undefined, protocol: string) {
  const counts = protocolCountMap(payload?.inFlightCoreHubProtocolBreakdown);
  return (counts.get(protocol) ?? 0) > 0;
}

function hub4HydrationSuppressionDetail(protocol: string, payload: OperatorLogMeta | undefined) {
  return (
    coreHubCooldownDetailForProtocol(payload, protocol) ?? (hasCoreHubInFlightForProtocol(payload, protocol) ? "in_flight" : undefined)
  );
}

function coreHubValidationFailureReasonForProtocol(payload: OperatorLogMeta | undefined, protocol: string) {
  if (!Array.isArray(payload?.validationReasonBreakdown)) return undefined;
  let best: { reason: string; pools: number } | undefined;
  for (const entry of payload.validationReasonBreakdown) {
    const record = recordObject(entry);
    if (!record) continue;
    if (cleanText(record.outcome) !== "failed") continue;
    if (cleanText(record.protocol) !== protocol) continue;
    if (cleanText(record.hubClass) !== "core_hub") continue;
    const pools = finiteCount(record.pools);
    if (pools == null || pools <= 0) continue;
    const reason = cleanText(record.reason);
    if (!reason) continue;
    if (!best || pools > best.pools || (pools === best.pools && reason.localeCompare(best.reason) < 0)) {
      best = { reason, pools };
    }
  }
  return best?.reason;
}

function hub4HydrationSelectionGapDetail(
  selectionGap: string | undefined,
  payload: OperatorLogMeta | undefined,
  selectedCoreHubPools = 0,
  selectedPools = 0,
  suppressionDetail?: string,
) {
  if (selectionGap !== "not_selected" && selectionGap !== "fetch_failed") return undefined;
  const reason = cleanText(payload?.reason);
  if (selectionGap === "fetch_failed") return quietPoolFetchFailureReason(payload?.reason) || undefined;
  if (suppressionDetail) return suppressionDetail;
  if (selectedCoreHubPools <= 0 && selectedPools > 0) return "selected_non_core";
  if (reason) return reason;
  const batchSize = recordValue(payload?.batchSize);
  const protocolDiversityCap = recordValue(payload?.protocolDiversityCap);
  if (batchSize != null && protocolDiversityCap != null) return `batch_${batchSize}_diversity_${protocolDiversityCap}`;
  if (batchSize != null) return `batch_${batchSize}`;
  return undefined;
}

function hub4HydrationAlignmentSummary(value: unknown, limit = 3) {
  if (!Array.isArray(value)) return null;
  const parts = value
    .map((entry) => {
      const record = recordObject(entry);
      if (!record) return null;
      const protocol = cleanText(record.protocol);
      const missing = finiteCount(record.hub4ActionableMissingPools);
      if (!protocol || missing == null || missing <= 0) return null;
      const pending = finiteCount(record.pendingCoreHubPools);
      const selected = finiteCount(record.selectedCoreHubPools);
      const selectedPools = finiteCount(record.selectedPools);
      const routablePools = finiteCount(record.routablePools);
      const observedCoreHubPools = finiteCount(record.observedUnroutableCoreHubPools);
      const fields = [`missing=${missing}`];
      if (pending != null) fields.push(`pending=${pending}`);
      if (selected != null) fields.push(`selectedCore=${selected}`);
      const selectedCoverageBps = displayBasisPoints(record.selectedCoreHubCoverageBps);
      if (selectedCoverageBps != null) fields.push(`selectedBps=${selectedCoverageBps}`);
      if (selectedPools != null && selectedPools > 0 && routablePools != null) {
        fields.push(`yield=${routablePools}/${selectedPools}`);
      }
      if (observedCoreHubPools != null && observedCoreHubPools > 0) fields.push(`observedCore=${observedCoreHubPools}`);
      const gap = cleanText(record.selectionGap);
      if (gap) fields.push(`gap=${gap}`);
      const gapDetail = cleanText(record.selectionGapDetail);
      if (gapDetail) fields.push(`detail=${gapDetail}`);
      return { missing, protocol, text: `${protocol}:${fields.join("/")}` };
    })
    .filter((entry): entry is { missing: number; protocol: string; text: string } => Boolean(entry))
    .sort((a, b) => b.missing - a.missing || a.protocol.localeCompare(b.protocol))
    .slice(0, limit)
    .map((entry) => entry.text);
  return parts.length > 0 ? parts.join(",") : null;
}

function hub4HydrationGapSummary(value: unknown, limit = 3) {
  if (!Array.isArray(value)) return null;
  const parts = value
    .map((entry) => {
      const record = recordObject(entry);
      if (!record) return null;
      const protocol = cleanText(record.protocol);
      const missing = finiteCount(record.hub4ActionableMissingPools);
      const gap = cleanText(record.selectionGap);
      if (!protocol || missing == null || missing <= 0 || !gap) return null;
      const detail = cleanText(record.selectionGapDetail);
      return { missing, protocol, text: detail ? `${protocol}:${gap}:${detail}` : `${protocol}:${gap}` };
    })
    .filter((entry): entry is { missing: number; protocol: string; text: string } => Boolean(entry))
    .sort((a, b) => b.missing - a.missing || a.protocol.localeCompare(b.protocol))
    .slice(0, limit)
    .map((entry) => entry.text);
  return parts.length > 0 ? parts.join(",") : null;
}

function buildHub4HydrationAlignment(routingUniverse: OperatorLogMeta | undefined, payload: OperatorLogMeta | undefined) {
  const hub4Missing = protocolCountMap(routingUniverse?.hub4ActionableMissingByProtocol ?? routingUniverse?.hub4AdjacentMissingByProtocol);
  if (hub4Missing.size === 0 || !payload) return undefined;
  const pendingCoreHub = protocolCountMap(payload.pendingCoreHubProtocolBreakdown);
  const selectedCoreHub = protocolCountMap(payload.selectedCoreHubProtocolBreakdown);
  const hasSelectedCoreHubBreakdown = Array.isArray(payload.selectedCoreHubProtocolBreakdown);
  const selected = protocolCountMap(payload.selectedProtocolBreakdown);
  const coreRoutable = protocolCountMap(payload.routableCoreHubProtocolBreakdown);
  const hasCoreRoutableBreakdown = Array.isArray(payload.routableCoreHubProtocolBreakdown);
  const coreObservedUnroutable = protocolCountMap(payload.observedUnroutableCoreHubProtocolBreakdown);
  const yields = protocolYieldMap(payload.protocolYieldBreakdown);
  const event = cleanText(payload.event);
  const rows = [...hub4Missing]
    .map(([protocol, hub4ActionableMissingPools]) => {
      const yieldEntry = yields.get(protocol);
      const selectedCoreHubPools = selectedCoreHub.get(protocol) ?? 0;
      const pendingCoreHubPools = pendingCoreHub.get(protocol) ?? 0;
      const broadSelectedPools = yieldEntry?.selectedPools ?? selected.get(protocol) ?? selectedCoreHubPools;
      const selectedPools = hasSelectedCoreHubBreakdown && selectedCoreHubPools > 0 ? selectedCoreHubPools : broadSelectedPools;
      const hasHydrationOutcome = event !== "quiet_pool_sweep_start";
      const routablePools = hasHydrationOutcome
        ? hasCoreRoutableBreakdown && selectedCoreHubPools > 0
          ? (coreRoutable.get(protocol) ?? 0)
          : (yieldEntry?.routablePools ?? 0)
        : undefined;
      const observedUnroutableCoreHubPools = hasHydrationOutcome ? (coreObservedUnroutable.get(protocol) ?? 0) : undefined;
      const suppressionDetail = hub4HydrationSuppressionDetail(protocol, payload);
      const validationFailureReason =
        event === "quiet_pool_sweep_complete" && selectedCoreHubPools > 0
          ? coreHubValidationFailureReasonForProtocol(payload, protocol)
          : undefined;
      const baseSelectionGap = hub4HydrationSelectionGap(
        pendingCoreHubPools,
        selectedCoreHubPools,
        selectedPools,
        routablePools ?? 0,
        observedUnroutableCoreHubPools ?? 0,
        event,
        Boolean(suppressionDetail),
      );
      const selectionGap =
        (baseSelectionGap === "zero_yield" || baseSelectionGap === "observed_unroutable") && validationFailureReason
          ? "validation_failed"
          : baseSelectionGap;
      const selectionGapDetail =
        validationFailureReason && selectionGap === "validation_failed"
          ? validationFailureReason
          : hub4HydrationSelectionGapDetail(selectionGap, payload, selectedCoreHubPools, selectedPools, suppressionDetail);
      return {
        protocol,
        hub4ActionableMissingPools,
        pendingCoreHubPools,
        selectedCoreHubPools,
        selectedCoreHubCoverageBps:
          hub4ActionableMissingPools > 0 ? Math.min(10000, Math.floor((selectedCoreHubPools * 10000) / hub4ActionableMissingPools)) : 0,
        selectedPools,
        ...(routablePools != null ? { routablePools } : {}),
        ...(observedUnroutableCoreHubPools != null && observedUnroutableCoreHubPools > 0 ? { observedUnroutableCoreHubPools } : {}),
        ...(selectionGap ? { selectionGap } : {}),
        ...(selectionGapDetail ? { selectionGapDetail } : {}),
      };
    })
    .sort((a, b) => {
      const missingDelta = b.hub4ActionableMissingPools - a.hub4ActionableMissingPools;
      return missingDelta !== 0 ? missingDelta : a.protocol.localeCompare(b.protocol);
    });
  return rows.length > 0 ? rows : undefined;
}

const QUIET_POOL_HUB4_ALIGNMENT_EVENTS = new Set([
  "quiet_pool_sweep_start",
  "quiet_pool_sweep_complete",
  "quiet_pool_sweep_fetch_failed",
  "quiet_pool_sweep_skipped",
]);

function augmentQuietPoolHydrationAlignment(payload: OperatorLogMeta | undefined, routingUniverse: OperatorLogMeta | undefined) {
  const event = cleanText(payload?.event);
  if (!payload || !routingUniverse || !event || !QUIET_POOL_HUB4_ALIGNMENT_EVENTS.has(event)) return payload;
  if (payload.hub4HydrationAlignment) return payload;
  const alignment = buildHub4HydrationAlignment(routingUniverse, payload);
  return alignment ? { ...payload, hub4HydrationAlignment: alignment } : payload;
}

function skippedObservedUnroutableCount(payload: OperatorLogMeta | undefined) {
  return displayCount(payload?.skippedObservedUnroutablePools ?? payload?.observedUnroutablePools);
}

function activityLabelForLog(msg: string, payload: OperatorLogMeta | undefined) {
  const explicit = cleanText(payload?.activity);
  if (explicit) return explicit;
  const event = cleanText(payload?.event);
  if (event && ACTIVITY_BY_EVENT[event]) return ACTIVITY_BY_EVENT[event];
  return null;
}

function activityDetailForLog(msg: string, payload: OperatorLogMeta | undefined) {
  const truncateDetail = (detail: string) => (detail.length <= 120 ? detail : `${detail.slice(0, 117)}...`);
  const explicit = cleanText(payload?.activityDetail);
  if (explicit) return truncateDetail(explicit);
  const event = cleanText(payload?.event);
  if (event === "quiet_pool_sweep_error") {
    const reason = quietPoolFetchFailureReason(errorReason(payload?.err) ?? errorReason(payload?.reason));
    if (reason) {
      const cleanMsg = cleanText(msg) ?? "Quiet-pool sweep error";
      const detail = cleanMsg.includes("quiet_pool_sweep_fetch_failed:")
        ? `Quiet-pool sweep error: ${reason}`
        : cleanMsg.includes(reason)
          ? cleanMsg
          : `Quiet-pool sweep error: ${reason}`;
      return truncateDetail(detail);
    }
  }
  if (event === "pending_state_refresh_error") {
    const reason = errorReason(payload?.err) ?? errorReason(payload?.reason);
    const cleanMsg = cleanText(msg) ?? "Pending state refresh failed";
    const detail = reason && !cleanMsg.includes(reason) ? `${cleanMsg}: ${reason}` : cleanMsg;
    return truncateDetail(detail);
  }
  return truncateDetail(msg);
}

function updateActivityFromLog(state: OperatorLogState, msg: string, payload: OperatorLogMeta | undefined, now: () => number) {
  const activity = activityLabelForLog(msg, payload);
  if (!activity) return;
  state.currentActivity = activity;
  state.currentActivityDetail = activityDetailForLog(msg, payload) ?? undefined;
  state.currentActivityProgress = normalizeActivityProgress(payload);
  state.currentActivityUpdatedMs = now();
}

export function summarizeLogForTui(msg: string, payload: OperatorLogMeta | undefined) {
  const event = typeof payload?.event === "string" ? payload.event : null;
  if (!payload) return msg;

  const parts: string[] = [];
  if (event) parts.push(event);
  const progress = summarizeActivityProgress(payload);
  if (progress) parts.push(`progress=${progress}`);
  pushDisplayCount(parts, "pass", payload.pass);
  pushDisplayCount(parts, "changed", payload.changedPools);
  pushDisplayCount(parts, "opps", payload.opportunities);
  pushDisplayCount(parts, "candidates", payload.candidates);
  pushDisplayCount(parts, "top", payload.topCandidates);
  pushDisplayCount(parts, "profitable", payload.profitableRoutes);
  const missingTokenRates = displayCount(payload.missingTokenRates);
  if (missingTokenRates != null && missingTokenRates > 0) {
    parts.push(`missingRates=${missingTokenRates}`);
  }
  const isRoutingUniverse = event === "routing_universe";
  if (isRoutingUniverse) {
    const activePools = displayCount(payload.activePools);
    if (activePools != null) parts.push(`active=${activePools}`);
    const topActive = protocolCountTopSummary(payload.topActiveProtocols);
    if (topActive) parts.push(`topActive=${topActive}`);
    const stateRows = displayCount(payload.stateRows);
    if (stateRows != null) parts.push(`state=${stateRows}`);
    const stateCoverageBps = displayBasisPoints(payload.stateCoverageBps);
    if (stateCoverageBps != null) parts.push(`stateBps=${stateCoverageBps}`);
    const topState = protocolCountTopSummary(payload.topStateProtocols);
    if (topState) parts.push(`topState=${topState}`);
    const stateGaps = stateCoverageGapSummary(payload.topStateCoverageGapsByProtocol);
    if (stateGaps) parts.push(`stateGaps=${stateGaps}`);
    const stateYield = stateYieldSummary(payload.topStateCoverageGapsByProtocol);
    if (stateYield) parts.push(`stateYield=${stateYield}`);
    const hub4StateGaps = stateCoverageGapSummary(payload.hub4StateCoverageGapsByProtocol);
    if (hub4StateGaps) parts.push(`hub4StateGaps=${hub4StateGaps}`);
    const hub4RoutableGaps = routableCoverageGapSummary(payload.hub4RoutableCoverageGapsByProtocol);
    if (hub4RoutableGaps) parts.push(`hub4RoutableGaps=${hub4RoutableGaps}`);
    const hub4StateYield = stateYieldSummary(payload.hub4StateCoverageGapsByProtocol);
    if (hub4StateYield) parts.push(`hub4StateYield=${hub4StateYield}`);
  }
  pushDisplayCount(parts, "pending", payload.pendingPools);
  const isQuietPoolStart = event === "quiet_pool_sweep_start";
  const isQuietPoolSkipped = event === "quiet_pool_sweep_skipped";
  const isQuietPoolComplete = event === "quiet_pool_sweep_complete";
  const isQuietPoolFetchFailed = event === "quiet_pool_sweep_fetch_failed";
  if (isQuietPoolStart || isQuietPoolSkipped || isQuietPoolComplete || isQuietPoolFetchFailed) {
    pushDisplayCount(parts, "backlog", payload.pendingBacklogPools);
    const batchSize = displayCount(payload.batchSize);
    if (payload.catchupActive === true && batchSize != null) {
      parts.push(`catchupBatch=${batchSize}`);
    } else if (batchSize != null) {
      parts.push(`batch=${batchSize}`);
    }
    const protocolDiversityCap = displayCount(payload.protocolDiversityCap);
    if (protocolDiversityCap != null) {
      const diversityCap =
        event === "quiet_pool_sweep_skipped" && payload.reason === "quiet_pool_sweep_batch_size_zero" ? 0 : protocolDiversityCap;
      parts.push(`diversityCap=${diversityCap}`);
    } else if (event === "quiet_pool_sweep_skipped" && payload.reason === "quiet_pool_sweep_batch_size_zero") {
      parts.push("diversityCap=0");
    }
  }
  if (isQuietPoolStart) {
    pushDisplayCount(parts, "invalidAddress", payload.invalidAddressPools);
    pushDisplayCount(parts, "unsupported", payload.unsupportedPools);
    pushDisplayCount(parts, "coolingDown", payload.coolingDownPools);
    const pendingTop = protocolCountTopSummary(payload.pendingProtocolBreakdown);
    if (pendingTop) parts.push(`pendingTop=${pendingTop}`);
    const pendingHub = hubClassCountSummary(payload.pendingHubClassBreakdown);
    if (pendingHub) parts.push(`pendingHub=${pendingHub}`);
    const pendingCoreHubTop = protocolCountTopSummary(payload.pendingCoreHubProtocolBreakdown);
    if (pendingCoreHubTop) parts.push(`pendingCoreHubTop=${pendingCoreHubTop}`);
    const pendingReasons = pendingReasonSummary(payload.pendingValidationReasonBreakdown, 3, true);
    if (pendingReasons) parts.push(`pendingReasons=${pendingReasons}`);
    const cooldownReasons = pendingReasonSummary(payload.cooldownReasonBreakdown, 3, true);
    if (cooldownReasons) parts.push(`cooldownReasons=${cooldownReasons}`);
    const selected = protocolCountSummary(payload.selectedProtocolBreakdown);
    if (selected) parts.push(`selected=${selected}`);
    const selectedHub = hubClassCountSummary(payload.selectedHubClassBreakdown);
    if (selectedHub) parts.push(`selectedHub=${selectedHub}`);
    const selectedCoreHubTop = protocolCountSummary(payload.selectedCoreHubProtocolBreakdown);
    if (selectedCoreHubTop) parts.push(`selectedCoreHubTop=${selectedCoreHubTop}`);
  }
  if (event === "quiet_pool_sweep_complete") {
    pushDisplayCount(parts, "invalidAddress", payload.invalidAddressPools);
    pushDisplayCount(parts, "unsupported", payload.unsupportedPools);
    pushDisplayCount(parts, "coolingDown", payload.coolingDownPools);
    pushDisplayCount(parts, "skippedObservedUnroutable", payload.skippedObservedUnroutablePools);
    const pendingTop = protocolCountTopSummary(payload.pendingProtocolBreakdown);
    if (pendingTop) parts.push(`pendingTop=${pendingTop}`);
    const pendingHub = hubClassCountSummary(payload.pendingHubClassBreakdown);
    if (pendingHub) parts.push(`pendingHub=${pendingHub}`);
    const pendingCoreHubTop = protocolCountTopSummary(payload.pendingCoreHubProtocolBreakdown);
    if (pendingCoreHubTop) parts.push(`pendingCoreHubTop=${pendingCoreHubTop}`);
    const pendingReasons = pendingReasonSummary(payload.pendingValidationReasonBreakdown, 3, true);
    if (pendingReasons) parts.push(`pendingReasons=${pendingReasons}`);
    const cooldownReasons = pendingReasonSummary(payload.cooldownReasonBreakdown, 3, true);
    if (cooldownReasons) parts.push(`cooldownReasons=${cooldownReasons}`);
    const selected = protocolCountSummary(payload.selectedProtocolBreakdown);
    if (selected) parts.push(`selected=${selected}`);
    const selectedHub = hubClassCountSummary(payload.selectedHubClassBreakdown);
    if (selectedHub) parts.push(`selectedHub=${selectedHub}`);
    const selectedCoreHubTop = protocolCountSummary(payload.selectedCoreHubProtocolBreakdown);
    if (selectedCoreHubTop) parts.push(`selectedCoreHubTop=${selectedCoreHubTop}`);
    const routableTop = protocolCountTopSummary(payload.routableProtocolBreakdown);
    if (routableTop) parts.push(`routableTop=${routableTop}`);
    const routableCoreHubTop = protocolCountTopSummary(payload.routableCoreHubProtocolBreakdown);
    if (routableCoreHubTop) parts.push(`routableCoreHubTop=${routableCoreHubTop}`);
    const routableHub = hubClassCountSummary(payload.routableHubClassBreakdown);
    if (routableHub) parts.push(`routableHub=${routableHub}`);
    const failedTop = protocolCountTopSummary(payload.failedProtocolBreakdown);
    if (failedTop) parts.push(`failedTop=${failedTop}`);
    const failedCoreHubTop = protocolCountTopSummary(payload.failedCoreHubProtocolBreakdown);
    if (failedCoreHubTop) parts.push(`failedCoreHubTop=${failedCoreHubTop}`);
    const failedHub = hubClassCountSummary(payload.failedHubClassBreakdown);
    if (failedHub) parts.push(`failedHub=${failedHub}`);
    const observedTop = protocolCountTopSummary(payload.observedUnroutableProtocolBreakdown);
    if (observedTop) parts.push(`observedTop=${observedTop}`);
    const observedCoreHubTop = protocolCountTopSummary(payload.observedUnroutableCoreHubProtocolBreakdown);
    if (observedCoreHubTop) parts.push(`observedCoreHubTop=${observedCoreHubTop}`);
    const observedHub = hubClassCountSummary(payload.observedUnroutableHubClassBreakdown);
    if (observedHub) parts.push(`observedHub=${observedHub}`);
    const protocolYield = yieldSummary(payload.protocolYieldBreakdown, "protocol");
    if (protocolYield) parts.push(`protocolYield=${protocolYield}`);
    const hubYield = yieldSummary(payload.hubClassYieldBreakdown, "hubClass");
    if (hubYield) parts.push(`hubYield=${hubYield}`);
  }
  if (isQuietPoolFetchFailed) {
    pushDisplayCount(parts, "invalidAddress", payload.invalidAddressPools);
    pushDisplayCount(parts, "unsupported", payload.unsupportedPools);
    pushDisplayCount(parts, "coolingDown", payload.coolingDownPools);
    const pendingTop = protocolCountTopSummary(payload.pendingProtocolBreakdown);
    if (pendingTop) parts.push(`pendingTop=${pendingTop}`);
    const pendingHub = hubClassCountSummary(payload.pendingHubClassBreakdown);
    if (pendingHub) parts.push(`pendingHub=${pendingHub}`);
    const pendingCoreHubTop = protocolCountTopSummary(payload.pendingCoreHubProtocolBreakdown);
    if (pendingCoreHubTop) parts.push(`pendingCoreHubTop=${pendingCoreHubTop}`);
    const pendingReasons = pendingReasonSummary(payload.pendingValidationReasonBreakdown, 3, true);
    if (pendingReasons) parts.push(`pendingReasons=${pendingReasons}`);
    const cooldownReasons = pendingReasonSummary(payload.cooldownReasonBreakdown, 3, true);
    if (cooldownReasons) parts.push(`cooldownReasons=${cooldownReasons}`);
    const selected = protocolCountSummary(payload.selectedProtocolBreakdown);
    if (selected) parts.push(`selected=${selected}`);
    const selectedHub = hubClassCountSummary(payload.selectedHubClassBreakdown);
    if (selectedHub) parts.push(`selectedHub=${selectedHub}`);
    const selectedCoreHubTop = protocolCountSummary(payload.selectedCoreHubProtocolBreakdown);
    if (selectedCoreHubTop) parts.push(`selectedCoreHubTop=${selectedCoreHubTop}`);
    const skippedObservedUnroutable = skippedObservedUnroutableCount(payload);
    if (skippedObservedUnroutable != null) parts.push(`skippedObservedUnroutable=${skippedObservedUnroutable}`);
    const protocolCoolingDownPools = displayCount(payload.protocolCoolingDownPools);
    if (protocolCoolingDownPools != null && protocolCoolingDownPools > 0) {
      parts.push(`protocolCooldown=${protocolCoolingDownPools}`);
    }
    pushDisplayCount(parts, "inFlight", payload.inFlightPools);
    const inFlightTop = protocolCountTopSummary(payload.inFlightProtocolBreakdown);
    if (inFlightTop) parts.push(`inFlightTop=${inFlightTop}`);
    const inFlightHub = hubClassCountSummary(payload.inFlightHubClassBreakdown);
    if (inFlightHub) parts.push(`inFlightHub=${inFlightHub}`);
    const inFlightCoreHubTop = protocolCountTopSummary(payload.inFlightCoreHubProtocolBreakdown);
    if (inFlightCoreHubTop) parts.push(`inFlightCoreHubTop=${inFlightCoreHubTop}`);
    pushDisplayCount(parts, "coreHubCandidates", payload.coreHubCandidatePools);
    const reason = quietPoolFetchFailureReason(payload.reason);
    if (reason) parts.push(`reason=${reason}`);
  }
  if (event === "quiet_pool_sweep_error") {
    pushDisplayCount(parts, "state", payload.stateSize);
    pushDisplayCount(parts, "paths", payload.cachedPaths);
    const reason = quietPoolFetchFailureReason(errorReason(payload.err) ?? errorReason(payload.reason));
    if (reason) parts.push(`reason=${reason}`);
  }
  if (event === "resource_guard_skip") {
    const reason = cleanText(payload.reason);
    if (reason) parts.push(`reason=${reason}`);
    const thermalState = cleanText(payload.thermalState);
    if (thermalState) parts.push(`thermal=${thermalState}`);
  }
  if (event === "pending_tx_touched_pools") {
    pushDisplayCount(parts, "hashes", payload.hashes);
    pushDisplayCount(parts, "touched", payload.touchedPools);
  }
  if (event === "pending_state_refresh") {
    pushDisplayCount(parts, "pools", payload.pools);
    pushDisplayCount(parts, "ttlMs", payload.ttlMs);
  }
  if (event === "pending_state_refresh_error") {
    pushDisplayCount(parts, "pools", payload.pools);
    pushDisplayCount(parts, "ttlMs", payload.ttlMs);
    const reason = errorReason(payload.err) ?? errorReason(payload.reason);
    if (reason) parts.push(`reason=${reason}`);
  }
  if (event === "pending_tx_watcher_disabled") {
    pushDisplayBooleanFlag(parts, "enabled", payload.enabled);
    pushDisplayBooleanFlag(parts, "hasWsUrl", payload.hasWsUrl);
  }
  if (event === "pending_tx_watcher_start") {
    pushDisplayCount(parts, "refreshTtlMs", payload.refreshTtlMs);
    pushDisplayCount(parts, "refreshBatch", payload.refreshBatchSize);
    pushDisplayCount(parts, "txBatch", payload.txFetchBatchSize);
    pushDisplayCount(parts, "txConcurrency", payload.txFetchConcurrency);
    pushDisplayBooleanFlag(parts, "includeV3", payload.includeV3Protocols);
  }
  if (event === "pending_tx_ws_error" || event === "block_ws_error") {
    const reason = errorReason(payload.err) ?? errorReason(payload.reason);
    if (reason) parts.push(`reason=${reason}`);
  }
  if (event === "execute_quarantine_add") {
    if (payload.reason) parts.push(`quarantine ${payload.reason}`);
    if (payload.source) parts.push(`source=${payload.source}`);
  }
  if (event === "execute_error") {
    const reason = errorReason(payload.err) ?? errorReason(payload.reason);
    if (reason) parts.push(`reason=${reason}`);
  }
  if (event === "execute_skip") {
    if (payload.reason) parts.push(`reason=${payload.reason}`);
  }
  if (event === "route_cache_evict_execution_failed") {
    pushDisplayCount(parts, "removed", payload.removed);
    if (payload.reason) parts.push(`reason=${payload.reason}`);
  }
  if (event === "scan_stale_route_refresh_start") {
    pushDisplayCount(parts, "pools", payload.pools);
    pushDisplayCount(parts, "paths", payload.consideredPaths);
    pushDisplayCount(parts, "missingRecords", payload.missingPoolRecords);
  }
  if (event === "scan_stale_route_refresh_complete") {
    pushDisplayCount(parts, "cached", payload.cachedPaths);
    pushDisplayCount(parts, "staleBefore", payload.stalePathsBefore);
    pushDisplayCount(parts, "freshAfter", payload.freshPathsAfter);
    pushDisplayCount(parts, "staleAfter", payload.stalePathsAfter);
  }
  if (event === "scan_stale_route_refresh_error") {
    const reason = errorReason(payload.error);
    if (reason) parts.push(`reason=${reason}`);
  }
  if (event === "scan_evaluation_start") {
    pushDisplayCount(parts, "paths", payload.paths);
  }
  if (event === "scan_skip_no_fresh_routes") {
    pushDisplayCount(parts, "cached", payload.cachedPaths);
    pushDisplayCount(parts, "stale", payload.stalePaths);
  }
  if (event === "ws_block") {
    const blockNumber = cleanText(payload.blockNumber);
    if (blockNumber) parts.push(`block=${blockNumber}`);
  }
  if (typeof payload.routablePools === "number") {
    const routablePools = displayCount(payload.routablePools);
    if (routablePools != null) parts.push(`routable=${routablePools}`);
  }
  if (isRoutingUniverse) {
    const routableCoverageBps = displayBasisPoints(payload.routableCoverageBps);
    if (routableCoverageBps != null) parts.push(`routableBps=${routableCoverageBps}`);
    const topRoutable = protocolCountTopSummary(payload.topRoutableProtocols);
    if (topRoutable) parts.push(`topRoutable=${topRoutable}`);
    const routableCoverageGaps = routableCoverageGapSummary(payload.topRoutableCoverageGapsByProtocol);
    if (routableCoverageGaps) parts.push(`routableCoverageGaps=${routableCoverageGaps}`);
    const hubAdjacentPools = displayCount(payload.hubAdjacentPools);
    if (hubAdjacentPools != null) parts.push(`hub=${hubAdjacentPools}`);
    const hubAdjacentUnroutablePools = displayCount(payload.hubAdjacentUnroutablePools);
    if (hubAdjacentUnroutablePools != null) {
      parts.push(`hubUnroutable=${hubAdjacentUnroutablePools}`);
    }
    const hubAdjacentRoutableBps = displayBasisPoints(payload.hubAdjacentRoutableBps);
    if (hubAdjacentRoutableBps != null) {
      parts.push(`hubRoutableBps=${hubAdjacentRoutableBps}`);
    }
    const hubBacklog = recordObject(payload.hubAdjacentHydrationBacklog) ?? recordObject(payload.hubAdjacentBacklog);
    const hubMissing = displayCount(hubBacklog?.missingStatePools);
    const hubInvalid = displayCount(hubBacklog?.invalidStatePools);
    const hubObserved = displayCount(hubBacklog?.observedUnroutablePools);
    const hubUnsupported = displayCount(hubBacklog?.unsupportedPools);
    if (hubMissing != null) parts.push(`hubMissing=${hubMissing}`);
    if (hubInvalid != null) parts.push(`hubInvalid=${hubInvalid}`);
    if (hubObserved != null) parts.push(`hubObservedUnroutable=${hubObserved}`);
    if (hubUnsupported != null && hubUnsupported > 0) parts.push(`hubUnsupported=${hubUnsupported}`);
    const hubTopMissing = protocolCountTopSummary(
      payload.hubAdjacentActionableMissingByProtocol ?? payload.actionableMissingByProtocol ?? payload.hubAdjacentMissingByProtocol,
    );
    if (hubTopMissing) parts.push(`hubTopMissing=${hubTopMissing}`);
    const hubTopInvalid = protocolCountTopSummary(payload.hubAdjacentInvalidByProtocol);
    if (hubTopInvalid) parts.push(`hubTopInvalid=${hubTopInvalid}`);
    const hubTopObserved = protocolCountTopSummary(payload.hubAdjacentObservedUnroutableByProtocol);
    if (hubTopObserved) parts.push(`hubTopObserved=${hubTopObserved}`);
    const hub4AdjacentPools = displayCount(payload.hub4AdjacentPools);
    if (hub4AdjacentPools != null) parts.push(`hub4=${hub4AdjacentPools}`);
    const hub4AdjacentUnroutablePools = displayCount(payload.hub4AdjacentUnroutablePools);
    if (hub4AdjacentUnroutablePools != null) {
      parts.push(`hub4Unroutable=${hub4AdjacentUnroutablePools}`);
    }
    const hub4AdjacentRoutableBps = displayBasisPoints(payload.hub4AdjacentRoutableBps);
    if (hub4AdjacentRoutableBps != null) {
      parts.push(`hub4RoutableBps=${hub4AdjacentRoutableBps}`);
    }
    const hub4Backlog = recordObject(payload.hub4AdjacentHydrationBacklog) ?? recordObject(payload.hub4AdjacentBacklog);
    const hub4Missing = displayCount(hub4Backlog?.missingStatePools);
    const hub4Invalid = displayCount(hub4Backlog?.invalidStatePools);
    const hub4Observed = displayCount(hub4Backlog?.observedUnroutablePools);
    const hub4Unsupported = displayCount(hub4Backlog?.unsupportedPools);
    if (hub4Missing != null) parts.push(`hub4Missing=${hub4Missing}`);
    if (hub4Invalid != null) parts.push(`hub4Invalid=${hub4Invalid}`);
    if (hub4Observed != null) parts.push(`hub4ObservedUnroutable=${hub4Observed}`);
    if (hub4Unsupported != null && hub4Unsupported > 0) parts.push(`hub4Unsupported=${hub4Unsupported}`);
    const hub4TopMissing = protocolCountTopSummary(payload.hub4ActionableMissingByProtocol ?? payload.hub4AdjacentMissingByProtocol);
    if (hub4TopMissing) parts.push(`hub4TopMissing=${hub4TopMissing}`);
    const hub4TopInvalid = protocolCountTopSummary(payload.hub4AdjacentInvalidByProtocol);
    if (hub4TopInvalid) parts.push(`hub4TopInvalid=${hub4TopInvalid}`);
    const hub4TopObserved = protocolCountTopSummary(payload.hub4AdjacentObservedUnroutableByProtocol);
    if (hub4TopObserved) parts.push(`hub4TopObserved=${hub4TopObserved}`);
    const topUnroutable = protocolCountTopSummary(payload.topUnroutableProtocols);
    if (topUnroutable) parts.push(`topUnroutable=${topUnroutable}`);
  }
  pushDisplayCount(parts, "admitted", payload.admittedPools);
  pushDisplayCount(parts, "failed", payload.failedPools);
  if (isQuietPoolSkipped) {
    pushDisplayCount(parts, "unsupported", payload.unsupportedPools);
    pushDisplayCount(parts, "invalidAddress", payload.invalidAddressPools);
    pushDisplayCount(parts, "coolingDown", payload.coolingDownPools);
    const pendingTop = protocolCountTopSummary(payload.pendingProtocolBreakdown);
    if (pendingTop) parts.push(`pendingTop=${pendingTop}`);
    const pendingHub = hubClassCountSummary(payload.pendingHubClassBreakdown);
    if (pendingHub) parts.push(`pendingHub=${pendingHub}`);
    const pendingCoreHubTop = protocolCountTopSummary(payload.pendingCoreHubProtocolBreakdown);
    if (pendingCoreHubTop) parts.push(`pendingCoreHubTop=${pendingCoreHubTop}`);
    const pendingReasons = pendingReasonSummary(payload.pendingValidationReasonBreakdown, 3, true);
    if (pendingReasons) parts.push(`pendingReasons=${pendingReasons}`);
    const cooldownReasons = pendingReasonSummary(payload.cooldownReasonBreakdown, 3, true);
    if (cooldownReasons) parts.push(`cooldownReasons=${cooldownReasons}`);
  }
  if (isQuietPoolStart) {
    const skippedObservedUnroutable = skippedObservedUnroutableCount(payload);
    if (skippedObservedUnroutable != null) parts.push(`skippedObservedUnroutable=${skippedObservedUnroutable}`);
  } else if (!isQuietPoolSkipped && !isQuietPoolFetchFailed) {
    pushDisplayCount(parts, "observedUnroutable", payload.observedUnroutablePools);
  }

  const hydrationYield = payload.hydrationYield;
  if (hydrationYield && typeof hydrationYield === "object" && !Array.isArray(hydrationYield)) {
    const summary = hydrationYield as Record<string, unknown>;
    const routableRateBps = displayBasisPoints(summary.routableRateBps);
    if (routableRateBps != null) parts.push(`routableBps=${routableRateBps}`);
    const admittedRateBps = displayBasisPoints(summary.admittedRateBps);
    if (admittedRateBps != null) parts.push(`admittedBps=${admittedRateBps}`);
  }
  const protocolCoolingDownPools = displayCount(payload.protocolCoolingDownPools);
  if (protocolCoolingDownPools != null && protocolCoolingDownPools > 0 && !isQuietPoolFetchFailed) {
    parts.push(`protocolCooldown=${protocolCoolingDownPools}`);
  }
  if (isQuietPoolSkipped || isQuietPoolStart || isQuietPoolComplete) {
    pushDisplayCount(parts, "inFlight", payload.inFlightPools);
    const inFlightTop = protocolCountTopSummary(payload.inFlightProtocolBreakdown);
    if (inFlightTop) parts.push(`inFlightTop=${inFlightTop}`);
    const inFlightHub = hubClassCountSummary(payload.inFlightHubClassBreakdown);
    if (inFlightHub) parts.push(`inFlightHub=${inFlightHub}`);
    const inFlightCoreHubTop = protocolCountTopSummary(payload.inFlightCoreHubProtocolBreakdown);
    if (inFlightCoreHubTop) parts.push(`inFlightCoreHubTop=${inFlightCoreHubTop}`);
    if (isQuietPoolSkipped) {
      const skippedObservedUnroutable = skippedObservedUnroutableCount(payload);
      if (skippedObservedUnroutable != null) parts.push(`skippedObservedUnroutable=${skippedObservedUnroutable}`);
    }
    pushDisplayCount(parts, "coreHubCandidates", payload.coreHubCandidatePools);
    if (isQuietPoolSkipped) {
      const reason = cleanText(payload.reason);
      if (reason) parts.push(`reason=${reason}`);
    }
  }

  if (isQuietPoolStart || isQuietPoolComplete || isQuietPoolFetchFailed || isQuietPoolSkipped) {
    if (isQuietPoolSkipped || isQuietPoolFetchFailed) {
      const hub4GapTop = hub4HydrationGapSummary(payload.hub4HydrationAlignment);
      if (hub4GapTop) parts.push(`hub4GapTop=${hub4GapTop}`);
    }
    const hub4Hydration = hub4HydrationAlignmentSummary(payload.hub4HydrationAlignment);
    if (hub4Hydration) parts.push(`hub4Hydration=${hub4Hydration}`);
  }

  const protocolCohortCooldown = protocolCohortCooldownSummary(payload.protocolCohortCooldownBreakdown);
  if (protocolCohortCooldown) parts.push(`topProtocolCooldown=${protocolCohortCooldown}`);

  const coreHubProtocolCohortCooldown = protocolCohortCooldownSummary(payload.coreHubProtocolCohortCooldownBreakdown);
  if (coreHubProtocolCohortCooldown) parts.push(`topCoreHubCooldown=${coreHubProtocolCohortCooldown}`);

  const validationReasonBreakdown = payload.validationReasonBreakdown;
  if (Array.isArray(validationReasonBreakdown)) {
    const topValidation = validationReasonBreakdown
      .map((entry) => {
        const record = recordObject(entry);
        if (!record || cleanText(record.outcome) !== "failed") return null;
        const protocol = cleanText(record.protocol);
        const hubClass = cleanText(record.hubClass);
        const reason = cleanText(record.reason);
        const pools = finiteCount(record.pools);
        return protocol && hubClass && reason && pools != null && pools > 0 ? { protocol, hubClass, reason, pools } : null;
      })
      .filter((entry): entry is { protocol: string; hubClass: string; reason: string; pools: number } => Boolean(entry))
      .sort(
        (a, b) =>
          b.pools - a.pools ||
          a.protocol.localeCompare(b.protocol) ||
          a.hubClass.localeCompare(b.hubClass) ||
          a.reason.localeCompare(b.reason),
      )
      .slice(0, 3)
      .map((entry) => `${entry.protocol}/${entry.hubClass}:${entry.reason}:${entry.pools}`);
    if (topValidation.length > 0) parts.push(`topValidation=${topValidation.join(",")}`);
  }

  const assessmentSummary = payload.assessmentSummary;
  if (assessmentSummary && typeof assessmentSummary === "object" && !Array.isArray(assessmentSummary)) {
    const summary = assessmentSummary as Record<string, unknown>;
    pushDisplayCount(parts, "assessed", summary.assessed);
    pushDisplayCount(parts, "rejected", summary.rejected);
    const assessedMissingRates = displayCount(summary.missingTokenRates);
    if (assessedMissingRates != null && assessedMissingRates > 0) {
      parts.push(`missingRates=${assessedMissingRates}`);
    }
    const rejectReason = topRejectSummary(summary.rejectReasons);
    if (rejectReason) parts.push(`topReject=${rejectReason}`);
  }

  const rejectReason = topRejectSummary(payload.rejectReasons);
  if (rejectReason) parts.push(`topReject=${rejectReason}`);
  if (typeof payload.txHash === "string") parts.push(`tx=${payload.txHash.slice(0, 10)}`);

  return parts.length > 0 ? `${parts.join(" ")} | ${msg}` : msg;
}

export function normalizeOperatorLogMeta(meta: OperatorLogMetaInput): OperatorLogMeta | undefined {
  const resolved = typeof meta === "function" ? meta() : meta;
  if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)) return undefined;
  return resolved as OperatorLogMeta;
}

export function appendOperatorLog(
  state: OperatorLogState,
  msg: string,
  level: string,
  meta: OperatorLogMetaInput = undefined,
  maxLogs = 10,
  now: () => number = Date.now,
) {
  const normalizedPayload = normalizeOperatorLogMeta(meta);
  const payload = augmentQuietPoolHydrationAlignment(normalizedPayload, state.lastRoutingUniverseMeta);
  state.logs.unshift(`[${level.toUpperCase()}] ${summarizeLogForTui(msg, payload)}`);
  if (state.logs.length > maxLogs) state.logs.length = maxLogs;
  updateActivityFromLog(state, msg, payload, now);
  if (payload?.event === "routing_universe") state.lastRoutingUniverseMeta = payload;
  return payload;
}
