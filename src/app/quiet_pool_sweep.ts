import { getPoolTokens, normalizeEvmAddress } from "../utils/pool_record.ts";
import { isObservedUnroutableWarmupState } from "../state/warmup.ts";
import { errorMessage } from "../utils/errors.ts";

type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";
type LoggerFn = (msg: string, level?: LogLevel, meta?: unknown) => void;

type PoolRecord = {
  pool_address: string;
  protocol: string;
  tokens: unknown;
  metadata?: unknown;
  status?: string;
  state?: { data?: Record<string, unknown> } | null;
};

type PoolState = Record<string, unknown>;
type StateCache = Map<string, PoolState>;
type ValidationReasonPool = {
  pool: PoolRecord;
  outcome: "failed" | "observed_unroutable";
  reason: string;
};
type PendingValidationReasonPool = {
  pool: PoolRecord;
  reason: string;
};

type RetryState = { attempts: number; nextRetryAt: number; lastReason: string };

type QuietPoolSweepDeps = {
  getRegistryPools: () => PoolRecord[];
  stateCache: StateCache;
  log: LoggerFn;
  isHydratablePool: (pool: PoolRecord) => boolean;
  validatePoolState: (state: PoolState | undefined) => { valid: boolean; reason?: string };
  fetchAndCacheStates: (pools: PoolRecord[], options: Record<string, unknown>) => Promise<unknown>;
  admitPools: (poolAddresses: Set<string>) => number;
  refreshCycles: (force?: boolean) => Promise<unknown>;
  quietPoolSweepBatchSize: number;
  quietPoolSweepCatchupBatchSize?: number;
  quietPoolSweepCatchupThreshold?: number;
  quietPoolSweepIntervalMs: number;
  quietPoolRetryBaseMs: number;
  quietPoolRetryMaxMs: number;
  v3NearWordRadius: number;
  polygonHubTokens: Set<string>;
  hub4Tokens: Set<string>;
};

function countTokenMatches(pool: PoolRecord, tokens: Set<string>) {
  return getPoolTokens(pool).filter((token) => tokens.has(token)).length;
}

function compareDeferredHydrationCohortPriority(
  a: PoolRecord,
  b: PoolRecord,
  polygonHubTokens: Set<string>,
  hub4Tokens: Set<string>,
  stateCache?: StateCache,
) {
  const aTokens = getPoolTokens(a);
  const bTokens = getPoolTokens(b);
  const aCoreHubMatches = aTokens.filter((token) => hub4Tokens.has(token)).length;
  const bCoreHubMatches = bTokens.filter((token) => hub4Tokens.has(token)).length;
  if (aCoreHubMatches !== bCoreHubMatches) return bCoreHubMatches - aCoreHubMatches;

  const aHubMatches = aTokens.filter((token) => polygonHubTokens.has(token)).length;
  const bHubMatches = bTokens.filter((token) => polygonHubTokens.has(token)).length;
  if (aHubMatches !== bHubMatches) return bHubMatches - aHubMatches;

  const aMissingState = stateCache ? !stateCache.has(a.pool_address.toLowerCase()) : false;
  const bMissingState = stateCache ? !stateCache.has(b.pool_address.toLowerCase()) : false;
  if (aMissingState !== bMissingState) return aMissingState ? -1 : 1;

  const aIsV3 = /V3|ELASTIC/.test(a.protocol);
  const bIsV3 = /V3|ELASTIC/.test(b.protocol);
  if (aIsV3 !== bIsV3) return aIsV3 ? 1 : -1;

  return 0;
}

function compareDeferredHydrationPriority(
  a: PoolRecord,
  b: PoolRecord,
  polygonHubTokens: Set<string>,
  hub4Tokens: Set<string>,
  stateCache?: StateCache,
) {
  return (
    compareDeferredHydrationCohortPriority(a, b, polygonHubTokens, hub4Tokens, stateCache) || a.pool_address.localeCompare(b.pool_address)
  );
}

function protocolDiversityCap(batchSize: number) {
  if (batchSize <= 0) return 0;
  return Math.max(1, Math.ceil(batchSize / 2));
}

function nonNegativeInteger(value: unknown, fallback: number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return fallback;
  return Math.floor(numeric);
}

function protocolBreakdown(pools: PoolRecord[], options: { sortByCount?: boolean } = {}) {
  const counts = new Map<string, number>();
  for (const pool of pools) {
    const protocol = String(pool.protocol ?? "UNKNOWN");
    counts.set(protocol, (counts.get(protocol) ?? 0) + 1);
  }
  const entries = [...counts].map(([protocol, pools]) => ({ protocol, pools }));
  if (!options.sortByCount) return entries;
  return entries.sort((a, b) => b.pools - a.pools || a.protocol.localeCompare(b.protocol));
}

function selectedHubClass(pool: PoolRecord, polygonHubTokens: Set<string>, hub4Tokens: Set<string>) {
  if (countTokenMatches(pool, hub4Tokens) > 0) return "core_hub";
  if (countTokenMatches(pool, polygonHubTokens) > 0) return "polygon_hub";
  return "non_hub";
}

function hubClassBreakdown(pools: PoolRecord[], polygonHubTokens: Set<string>, hub4Tokens: Set<string>) {
  const counts = new Map<string, number>();
  for (const pool of pools) {
    const hubClass = selectedHubClass(pool, polygonHubTokens, hub4Tokens);
    counts.set(hubClass, (counts.get(hubClass) ?? 0) + 1);
  }
  return ["core_hub", "polygon_hub", "non_hub"]
    .map((hubClass) => ({ hubClass, pools: counts.get(hubClass) ?? 0 }))
    .filter((entry) => entry.pools > 0);
}

function poolsForHubClass(pools: PoolRecord[], hubClass: string, polygonHubTokens: Set<string>, hub4Tokens: Set<string>) {
  return pools.filter((pool) => selectedHubClass(pool, polygonHubTokens, hub4Tokens) === hubClass);
}

function protocolBreakdownForHubClass(pools: PoolRecord[], hubClass: string, polygonHubTokens: Set<string>, hub4Tokens: Set<string>) {
  return protocolBreakdown(poolsForHubClass(pools, hubClass, polygonHubTokens, hub4Tokens), { sortByCount: true });
}

function validationReasonBreakdown(entries: ValidationReasonPool[], polygonHubTokens: Set<string>, hub4Tokens: Set<string>) {
  const counts = new Map<string, { outcome: string; protocol: string; hubClass: string; reason: string; pools: number }>();
  for (const entry of entries) {
    const protocol = String(entry.pool.protocol ?? "UNKNOWN");
    const hubClass = selectedHubClass(entry.pool, polygonHubTokens, hub4Tokens);
    const key = `${entry.outcome}\u0000${protocol}\u0000${hubClass}\u0000${entry.reason}`;
    const current = counts.get(key);
    if (current) {
      current.pools++;
    } else {
      counts.set(key, {
        outcome: entry.outcome,
        protocol,
        hubClass,
        reason: entry.reason,
        pools: 1,
      });
    }
  }
  return [...counts.values()].sort(
    (a, b) =>
      b.pools - a.pools ||
      a.outcome.localeCompare(b.outcome) ||
      a.protocol.localeCompare(b.protocol) ||
      a.hubClass.localeCompare(b.hubClass) ||
      a.reason.localeCompare(b.reason),
  );
}

type PendingReasonBreakdown = { protocol: string; hubClass: string; reason: string; pools: number };

function sortPendingReasonBreakdown(entries: PendingReasonBreakdown[]) {
  return entries.sort(
    (a, b) =>
      b.pools - a.pools || a.protocol.localeCompare(b.protocol) || a.hubClass.localeCompare(b.hubClass) || a.reason.localeCompare(b.reason),
  );
}

function pendingValidationReasonBreakdown(entries: PendingValidationReasonPool[], polygonHubTokens: Set<string>, hub4Tokens: Set<string>) {
  const counts = new Map<string, PendingReasonBreakdown>();
  for (const entry of entries) {
    const protocol = String(entry.pool.protocol ?? "UNKNOWN");
    const hubClass = selectedHubClass(entry.pool, polygonHubTokens, hub4Tokens);
    const reason = entry.reason || "state_not_routable";
    const key = `${protocol}\u0000${hubClass}\u0000${reason}`;
    const current = counts.get(key);
    if (current) {
      current.pools++;
    } else {
      counts.set(key, { protocol, hubClass, reason, pools: 1 });
    }
  }
  return sortPendingReasonBreakdown([...counts.values()]);
}

function mergePendingReasonBreakdowns(...breakdowns: PendingReasonBreakdown[][]) {
  const counts = new Map<string, PendingReasonBreakdown>();
  for (const breakdown of breakdowns) {
    for (const entry of breakdown) {
      const key = `${entry.protocol}\u0000${entry.hubClass}\u0000${entry.reason}`;
      const current = counts.get(key);
      if (current) {
        current.pools += entry.pools;
      } else {
        counts.set(key, { ...entry });
      }
    }
  }
  return sortPendingReasonBreakdown([...counts.values()]);
}

function rateBps(numerator: number, denominator: number) {
  if (denominator <= 0) return 0;
  return Math.floor((numerator * 10_000) / denominator);
}

function hydrationYield(pendingPools: number, routablePools: number, admittedPools: number) {
  return {
    pendingPools,
    routablePools,
    admittedPools,
    routableRateBps: rateBps(routablePools, pendingPools),
    admittedRateBps: rateBps(admittedPools, pendingPools),
  };
}

function protocolYieldBreakdown(selectedPools: PoolRecord[], routablePools: PoolRecord[]) {
  const selectedCounts = new Map<string, number>();
  const routableCounts = new Map<string, number>();
  for (const pool of selectedPools) {
    const protocol = String(pool.protocol ?? "UNKNOWN");
    selectedCounts.set(protocol, (selectedCounts.get(protocol) ?? 0) + 1);
  }
  for (const pool of routablePools) {
    const protocol = String(pool.protocol ?? "UNKNOWN");
    routableCounts.set(protocol, (routableCounts.get(protocol) ?? 0) + 1);
  }
  return [...selectedCounts].map(([protocol, selectedPools]) => {
    const routablePools = routableCounts.get(protocol) ?? 0;
    return {
      protocol,
      selectedPools,
      routablePools,
      routableRateBps: rateBps(routablePools, selectedPools),
    };
  });
}

function protocolCohortCooldowns(
  selectedPools: PoolRecord[],
  routablePools: PoolRecord[],
  failedPools: PoolRecord[],
  minSelectedPools: number,
) {
  const selectedCounts = new Map<string, number>();
  const routableCounts = new Map<string, number>();
  const failedCounts = new Map<string, number>();
  for (const pool of selectedPools) {
    const protocol = String(pool.protocol ?? "UNKNOWN");
    selectedCounts.set(protocol, (selectedCounts.get(protocol) ?? 0) + 1);
  }
  for (const pool of routablePools) {
    const protocol = String(pool.protocol ?? "UNKNOWN");
    routableCounts.set(protocol, (routableCounts.get(protocol) ?? 0) + 1);
  }
  for (const pool of failedPools) {
    const protocol = String(pool.protocol ?? "UNKNOWN");
    failedCounts.set(protocol, (failedCounts.get(protocol) ?? 0) + 1);
  }

  return [...selectedCounts]
    .filter(([protocol, selectedPools]) => {
      if (selectedPools < minSelectedPools) return false;
      if ((routableCounts.get(protocol) ?? 0) > 0) return false;
      return (failedCounts.get(protocol) ?? 0) > 0;
    })
    .map(([protocol, selectedPools]) => ({
      protocol,
      selectedPools,
      failedPools: failedCounts.get(protocol) ?? 0,
    }))
    .sort((a, b) => b.selectedPools - a.selectedPools || b.failedPools - a.failedPools || a.protocol.localeCompare(b.protocol));
}

function hubClassYieldBreakdown(
  selectedPools: PoolRecord[],
  routablePools: PoolRecord[],
  polygonHubTokens: Set<string>,
  hub4Tokens: Set<string>,
) {
  const selectedCounts = new Map<string, number>();
  const routableCounts = new Map<string, number>();
  for (const pool of selectedPools) {
    const hubClass = selectedHubClass(pool, polygonHubTokens, hub4Tokens);
    selectedCounts.set(hubClass, (selectedCounts.get(hubClass) ?? 0) + 1);
  }
  for (const pool of routablePools) {
    const hubClass = selectedHubClass(pool, polygonHubTokens, hub4Tokens);
    routableCounts.set(hubClass, (routableCounts.get(hubClass) ?? 0) + 1);
  }
  return ["core_hub", "polygon_hub", "non_hub"]
    .filter((hubClass) => selectedCounts.has(hubClass))
    .map((hubClass) => {
      const selectedPools = selectedCounts.get(hubClass) ?? 0;
      const routablePools = routableCounts.get(hubClass) ?? 0;
      return {
        hubClass,
        selectedPools,
        routablePools,
        routableRateBps: rateBps(routablePools, selectedPools),
      };
    });
}

function selectDiversePendingPools(
  pending: PoolRecord[],
  batchSize: number,
  polygonHubTokens: Set<string>,
  hub4Tokens: Set<string>,
  stateCache?: StateCache,
) {
  const limit = Math.max(0, batchSize);
  if (limit === 0 || pending.length === 0) return [];
  const cap = protocolDiversityCap(limit);
  const sorted = [...pending].sort((a, b) => compareDeferredHydrationPriority(a, b, polygonHubTokens, hub4Tokens, stateCache));
  const selected: PoolRecord[] = [];
  const selectedAddrs = new Set<string>();
  const protocolCounts = new Map<string, number>();
  const poolsByProtocol = new Map<string, PoolRecord[]>();
  for (const pool of sorted) {
    const protocol = String(pool.protocol ?? "UNKNOWN");
    const protocolPools = poolsByProtocol.get(protocol);
    if (protocolPools) {
      protocolPools.push(pool);
    } else {
      poolsByProtocol.set(protocol, [pool]);
    }
  }

  function leadingCohortSize(protocolPools: PoolRecord[]) {
    const first = protocolPools[0];
    if (!first) return 0;
    return protocolPools.filter(
      (pool) => compareDeferredHydrationCohortPriority(first, pool, polygonHubTokens, hub4Tokens, stateCache) === 0,
    ).length;
  }

  const scarceAcrossProtocols = limit < poolsByProtocol.size;
  const protocolEntries = [...poolsByProtocol].sort(([aProtocol, aPools], [bProtocol, bPools]) => {
    const aFirst = aPools[0];
    const bFirst = bPools[0];
    if (aFirst && bFirst) {
      const priority = compareDeferredHydrationCohortPriority(aFirst, bFirst, polygonHubTokens, hub4Tokens, stateCache);
      if (priority !== 0) return priority;
    }
    if (scarceAcrossProtocols) {
      const cohortSizeDelta = leadingCohortSize(bPools) - leadingCohortSize(aPools);
      if (cohortSizeDelta !== 0) return cohortSizeDelta;
    }
    if (aFirst && bFirst) return aFirst.pool_address.localeCompare(bFirst.pool_address);
    return aProtocol.localeCompare(bProtocol);
  });

  let madeDiverseSelection = true;
  while (selected.length < limit && madeDiverseSelection) {
    madeDiverseSelection = false;
    for (const [protocol, protocolPools] of protocolEntries) {
      if (selected.length >= limit) break;
      if ((protocolCounts.get(protocol) ?? 0) >= cap) continue;
      let pool = protocolPools.shift();
      while (pool && selectedAddrs.has(pool.pool_address.toLowerCase())) {
        pool = protocolPools.shift();
      }
      if (!pool) continue;
      selected.push(pool);
      selectedAddrs.add(pool.pool_address.toLowerCase());
      protocolCounts.set(protocol, (protocolCounts.get(protocol) ?? 0) + 1);
      madeDiverseSelection = true;
    }
  }

  for (const pool of sorted) {
    if (selected.length >= limit) break;
    const addr = pool.pool_address.toLowerCase();
    if (selectedAddrs.has(addr)) continue;
    selected.push(pool);
    selectedAddrs.add(addr);
  }

  return selected;
}

export function createQuietPoolSweepCoordinator(deps: QuietPoolSweepDeps) {
  let lastQuietPoolSweepAt = 0;
  let quietSweepRunning = false;
  const deferredHydrationInFlight = new Set<string>();
  const deferredHydrationRetryState = new Map<string, RetryState>();
  const protocolRetryState = new Map<string, RetryState>();
  const protocolZeroYieldStreak = new Map<string, number>();

  function quietPoolBatchSizing(pendingBacklogPools: number) {
    const baseBatchSize = nonNegativeInteger(deps.quietPoolSweepBatchSize, 0);
    const catchupThreshold = nonNegativeInteger(deps.quietPoolSweepCatchupThreshold, Number.POSITIVE_INFINITY);
    const catchupBatchSize = Math.max(baseBatchSize, nonNegativeInteger(deps.quietPoolSweepCatchupBatchSize, baseBatchSize));
    const catchupActive =
      baseBatchSize > 0 && catchupBatchSize > baseBatchSize && catchupThreshold > 0 && pendingBacklogPools >= catchupThreshold;

    return {
      batchSize: catchupActive ? catchupBatchSize : baseBatchSize,
      baseBatchSize,
      catchupBatchSize,
      catchupThreshold,
      catchupActive,
      pendingBacklogPools,
    };
  }

  function nextDeferredHydrationRetryMs(attempts: number) {
    const exponent = Math.max(0, attempts - 1);
    return Math.min(deps.quietPoolRetryMaxMs, deps.quietPoolRetryBaseMs * 2 ** exponent);
  }

  function clearDeferredHydrationRetry(addr: string) {
    deferredHydrationRetryState.delete(addr);
  }

  function recordDeferredHydrationFailure(addr: string, reason: string) {
    const current = deferredHydrationRetryState.get(addr);
    const attempts = (current?.attempts ?? 0) + 1;
    deferredHydrationRetryState.set(addr, {
      attempts,
      nextRetryAt: Date.now() + nextDeferredHydrationRetryMs(attempts),
      lastReason: reason,
    });
  }

  function clearProtocolRetry(protocol: string) {
    protocolRetryState.delete(protocol);
    protocolZeroYieldStreak.delete(protocol);
  }

  function recordProtocolCohortFailure(protocol: string, reason: string, minAttempts = 1) {
    const current = protocolRetryState.get(protocol);
    const attempts = (current?.attempts ?? 0) + 1;
    protocolRetryState.set(protocol, {
      attempts,
      nextRetryAt: attempts >= minAttempts ? Date.now() + nextDeferredHydrationRetryMs(attempts) : Date.now(),
      lastReason: reason,
    });
  }

  function beginDeferredHydration(pools: PoolRecord[]) {
    const accepted: PoolRecord[] = [];
    for (const pool of pools) {
      const addr = pool.pool_address.toLowerCase();
      if (deferredHydrationInFlight.has(addr)) continue;
      deferredHydrationInFlight.add(addr);
      accepted.push(pool);
    }
    return accepted;
  }

  function finishDeferredHydration(pools: PoolRecord[]) {
    for (const pool of pools) {
      deferredHydrationInFlight.delete(pool.pool_address.toLowerCase());
    }
  }

  function selectPendingQuietPools(activePools: PoolRecord[]) {
    const now = Date.now();
    const pending: PoolRecord[] = [];
    let unsupportedPools = 0;
    let invalidAddressPools = 0;
    let coolingDownPools = 0;
    let protocolCoolingDownPools = 0;
    let inFlightPools = 0;
    let observedUnroutablePools = 0;
    let coreHubCandidatePools = 0;
    const pendingValidationReasonRecords: PendingValidationReasonPool[] = [];
    const cooldownReasonRecords: PendingValidationReasonPool[] = [];
    const inFlightPoolRecords: PoolRecord[] = [];
    const uniquePoolsByAddr = new Map<string, PoolRecord>();
    for (const pool of activePools) {
      const addr = normalizeEvmAddress(pool.pool_address);
      if (!addr) {
        invalidAddressPools++;
        continue;
      }
      const existing = uniquePoolsByAddr.get(addr);
      if (!existing) {
        uniquePoolsByAddr.set(addr, pool);
        continue;
      }
      const existingHydratable = deps.isHydratablePool(existing);
      const currentHydratable = deps.isHydratablePool(pool);
      if (existingHydratable !== currentHydratable) {
        if (currentHydratable) uniquePoolsByAddr.set(addr, pool);
        continue;
      }
      if (
        currentHydratable &&
        compareDeferredHydrationPriority(pool, existing, deps.polygonHubTokens, deps.hub4Tokens, deps.stateCache) < 0
      ) {
        uniquePoolsByAddr.set(addr, pool);
      }
    }
    for (const pool of uniquePoolsByAddr.values()) {
      const addr = normalizeEvmAddress(pool.pool_address)!;
      const state = deps.stateCache.get(addr);
      const verdict = deps.validatePoolState(state);
      if (verdict.valid) continue;
      if (!deps.isHydratablePool(pool)) {
        unsupportedPools++;
        continue;
      }
      if (isObservedUnroutableWarmupState(state, verdict)) {
        observedUnroutablePools++;
        continue;
      }
      if (deferredHydrationInFlight.has(addr)) {
        inFlightPools++;
        inFlightPoolRecords.push(pool);
        continue;
      }
      const retryState = deferredHydrationRetryState.get(addr);
      if (retryState && retryState.nextRetryAt > now) {
        coolingDownPools++;
        cooldownReasonRecords.push({ pool, reason: retryState.lastReason });
        continue;
      }
      const protocol = String(pool.protocol ?? "UNKNOWN");
      const protocolRetry = protocolRetryState.get(protocol);
      if (protocolRetry && protocolRetry.nextRetryAt > now) {
        protocolCoolingDownPools++;
        cooldownReasonRecords.push({ pool, reason: protocolRetry.lastReason });
        continue;
      }
      if (countTokenMatches(pool, deps.hub4Tokens) > 0) coreHubCandidatePools++;
      pending.push(pool);
      pendingValidationReasonRecords.push({ pool, reason: verdict.reason ?? "state_not_routable" });
    }
    const sizing = quietPoolBatchSizing(pending.length);
    const diversityCap = protocolDiversityCap(sizing.batchSize);
    const selectedPending = selectDiversePendingPools(pending, sizing.batchSize, deps.polygonHubTokens, deps.hub4Tokens, deps.stateCache);
    return {
      pending: selectedPending,
      pendingBacklogPools: sizing.pendingBacklogPools,
      batchSize: sizing.batchSize,
      baseBatchSize: sizing.baseBatchSize,
      catchupBatchSize: sizing.catchupBatchSize,
      catchupThreshold: sizing.catchupThreshold,
      catchupActive: sizing.catchupActive,
      skippedUnsupportedPools: unsupportedPools,
      skippedInvalidAddressPools: invalidAddressPools,
      skippedCoolingDownPools: coolingDownPools,
      skippedProtocolCoolingDownPools: protocolCoolingDownPools,
      skippedInFlightPools: inFlightPools,
      skippedObservedUnroutablePools: observedUnroutablePools,
      coreHubCandidatePools,
      protocolDiversityCap: diversityCap,
      pendingProtocolBreakdown: protocolBreakdown(pending, { sortByCount: true }),
      pendingHubClassBreakdown: hubClassBreakdown(pending, deps.polygonHubTokens, deps.hub4Tokens),
      pendingCoreHubProtocolBreakdown: protocolBreakdownForHubClass(pending, "core_hub", deps.polygonHubTokens, deps.hub4Tokens),
      pendingValidationReasonBreakdown: pendingValidationReasonBreakdown(
        pendingValidationReasonRecords,
        deps.polygonHubTokens,
        deps.hub4Tokens,
      ),
      cooldownReasonBreakdown: pendingValidationReasonBreakdown(cooldownReasonRecords, deps.polygonHubTokens, deps.hub4Tokens),
      inFlightProtocolBreakdown: protocolBreakdown(inFlightPoolRecords, { sortByCount: true }),
      inFlightHubClassBreakdown: hubClassBreakdown(inFlightPoolRecords, deps.polygonHubTokens, deps.hub4Tokens),
      inFlightCoreHubProtocolBreakdown: protocolBreakdownForHubClass(
        inFlightPoolRecords,
        "core_hub",
        deps.polygonHubTokens,
        deps.hub4Tokens,
      ),
      selectedProtocolBreakdown: protocolBreakdown(selectedPending),
      selectedHubClassBreakdown: hubClassBreakdown(selectedPending, deps.polygonHubTokens, deps.hub4Tokens),
    };
  }

  async function maybeHydrateQuietPools() {
    const now = Date.now();
    if (now - lastQuietPoolSweepAt < deps.quietPoolSweepIntervalMs) return;
    if (quietSweepRunning) return;
    lastQuietPoolSweepAt = now;
    quietSweepRunning = true;
    let claimedPools: PoolRecord[] = [];

    try {
      const activePools = deps.getRegistryPools();
      const selection = selectPendingQuietPools(activePools);
      const pending = beginDeferredHydration(selection.pending);
      const claimedSelectedProtocolBreakdown = protocolBreakdown(pending);
      const claimedSelectedHubClassBreakdown = hubClassBreakdown(pending, deps.polygonHubTokens, deps.hub4Tokens);
      const claimedSelectedCoreHubProtocolBreakdown = protocolBreakdownForHubClass(
        pending,
        "core_hub",
        deps.polygonHubTokens,
        deps.hub4Tokens,
      );
      claimedPools = pending;

      if (pending.length === 0) {
        const skipReason = selection.pendingBacklogPools > 0 && selection.batchSize === 0 ? "quiet_pool_sweep_batch_size_zero" : undefined;
        if (
          skipReason ||
          selection.skippedUnsupportedPools > 0 ||
          selection.skippedInvalidAddressPools > 0 ||
          selection.skippedCoolingDownPools > 0 ||
          selection.skippedProtocolCoolingDownPools > 0 ||
          selection.skippedInFlightPools > 0 ||
          selection.skippedObservedUnroutablePools > 0
        ) {
          deps.log("[runner] Quiet-pool sweep skipped all currently invalid pools.", "debug", {
            event: "quiet_pool_sweep_skipped",
            reason: skipReason,
            pendingBacklogPools: selection.pendingBacklogPools,
            batchSize: selection.batchSize,
            baseBatchSize: selection.baseBatchSize,
            catchupBatchSize: selection.catchupBatchSize,
            catchupThreshold: selection.catchupThreshold,
            catchupActive: selection.catchupActive,
            unsupportedPools: selection.skippedUnsupportedPools,
            invalidAddressPools: selection.skippedInvalidAddressPools,
            coolingDownPools: selection.skippedCoolingDownPools,
            protocolCoolingDownPools: selection.skippedProtocolCoolingDownPools,
            inFlightPools: selection.skippedInFlightPools,
            observedUnroutablePools: selection.skippedObservedUnroutablePools,
            skippedObservedUnroutablePools: selection.skippedObservedUnroutablePools,
            coreHubCandidatePools: selection.coreHubCandidatePools,
            protocolDiversityCap: selection.protocolDiversityCap,
            pendingProtocolBreakdown: selection.pendingProtocolBreakdown,
            pendingHubClassBreakdown: selection.pendingHubClassBreakdown,
            pendingCoreHubProtocolBreakdown: selection.pendingCoreHubProtocolBreakdown,
            pendingValidationReasonBreakdown: selection.pendingValidationReasonBreakdown,
            cooldownReasonBreakdown: selection.cooldownReasonBreakdown,
            inFlightProtocolBreakdown: selection.inFlightProtocolBreakdown,
            inFlightHubClassBreakdown: selection.inFlightHubClassBreakdown,
            inFlightCoreHubProtocolBreakdown: selection.inFlightCoreHubProtocolBreakdown,
            selectedProtocolBreakdown: claimedSelectedProtocolBreakdown,
            selectedHubClassBreakdown: claimedSelectedHubClassBreakdown,
            selectedCoreHubProtocolBreakdown: claimedSelectedCoreHubProtocolBreakdown,
          });
        }
        return;
      }

      deps.log(`[runner] Quiet-pool sweep: hydrating ${pending.length} deferred pool(s).`, "info", {
        event: "quiet_pool_sweep_start",
        pendingPools: pending.length,
        pendingBacklogPools: selection.pendingBacklogPools,
        batchSize: selection.batchSize,
        baseBatchSize: selection.baseBatchSize,
        catchupBatchSize: selection.catchupBatchSize,
        catchupThreshold: selection.catchupThreshold,
        catchupActive: selection.catchupActive,
        unsupportedPools: selection.skippedUnsupportedPools,
        invalidAddressPools: selection.skippedInvalidAddressPools,
        coolingDownPools: selection.skippedCoolingDownPools,
        protocolCoolingDownPools: selection.skippedProtocolCoolingDownPools,
        inFlightPools: selection.skippedInFlightPools,
        observedUnroutablePools: selection.skippedObservedUnroutablePools,
        skippedObservedUnroutablePools: selection.skippedObservedUnroutablePools,
        coreHubCandidatePools: selection.coreHubCandidatePools,
        protocolDiversityCap: selection.protocolDiversityCap,
        pendingProtocolBreakdown: selection.pendingProtocolBreakdown,
        pendingHubClassBreakdown: selection.pendingHubClassBreakdown,
        pendingCoreHubProtocolBreakdown: selection.pendingCoreHubProtocolBreakdown,
        pendingValidationReasonBreakdown: selection.pendingValidationReasonBreakdown,
        cooldownReasonBreakdown: selection.cooldownReasonBreakdown,
        inFlightProtocolBreakdown: selection.inFlightProtocolBreakdown,
        inFlightHubClassBreakdown: selection.inFlightHubClassBreakdown,
        inFlightCoreHubProtocolBreakdown: selection.inFlightCoreHubProtocolBreakdown,
        selectedProtocolBreakdown: claimedSelectedProtocolBreakdown,
        selectedHubClassBreakdown: claimedSelectedHubClassBreakdown,
        selectedCoreHubProtocolBreakdown: claimedSelectedCoreHubProtocolBreakdown,
      });

      let warmupStats: unknown;
      try {
        warmupStats = await deps.fetchAndCacheStates(pending, {
          v3HydrationMode: "nearby",
          v3NearWordRadius: deps.v3NearWordRadius,
          logContext: {
            label: "Quiet-pool hydration",
            eventPrefix: "quiet_pool_sweep",
          },
        });
      } catch (err) {
        const reason = `quiet_pool_sweep_fetch_failed: ${errorMessage(err)}`;
        for (const pool of pending) recordDeferredHydrationFailure(pool.pool_address.toLowerCase(), reason);
        const fetchFailureCooldownReasonBreakdown = mergePendingReasonBreakdowns(
          selection.cooldownReasonBreakdown,
          pendingValidationReasonBreakdown(
            pending.map((pool) => ({ pool, reason })),
            deps.polygonHubTokens,
            deps.hub4Tokens,
          ),
        );
        deps.log("[runner] Quiet-pool sweep hydration failed; pending pools entered retry cooldown.", "warn", {
          event: "quiet_pool_sweep_fetch_failed",
          pendingPools: pending.length,
          pendingBacklogPools: selection.pendingBacklogPools,
          batchSize: selection.batchSize,
          baseBatchSize: selection.baseBatchSize,
          catchupBatchSize: selection.catchupBatchSize,
          catchupThreshold: selection.catchupThreshold,
          catchupActive: selection.catchupActive,
          unsupportedPools: selection.skippedUnsupportedPools,
          invalidAddressPools: selection.skippedInvalidAddressPools,
          coolingDownPools: selection.skippedCoolingDownPools,
          protocolCoolingDownPools: selection.skippedProtocolCoolingDownPools,
          inFlightPools: selection.skippedInFlightPools,
          observedUnroutablePools: selection.skippedObservedUnroutablePools,
          skippedObservedUnroutablePools: selection.skippedObservedUnroutablePools,
          coreHubCandidatePools: selection.coreHubCandidatePools,
          protocolDiversityCap: selection.protocolDiversityCap,
          pendingProtocolBreakdown: selection.pendingProtocolBreakdown,
          pendingHubClassBreakdown: selection.pendingHubClassBreakdown,
          pendingCoreHubProtocolBreakdown: selection.pendingCoreHubProtocolBreakdown,
          pendingValidationReasonBreakdown: selection.pendingValidationReasonBreakdown,
          cooldownReasonBreakdown: fetchFailureCooldownReasonBreakdown,
          inFlightProtocolBreakdown: selection.inFlightProtocolBreakdown,
          inFlightHubClassBreakdown: selection.inFlightHubClassBreakdown,
          inFlightCoreHubProtocolBreakdown: selection.inFlightCoreHubProtocolBreakdown,
          selectedProtocolBreakdown: claimedSelectedProtocolBreakdown,
          selectedHubClassBreakdown: claimedSelectedHubClassBreakdown,
          selectedCoreHubProtocolBreakdown: claimedSelectedCoreHubProtocolBreakdown,
          reason,
        });
        throw err;
      }

      const hydratedAddrs = new Set<string>();
      const hydratedPools: PoolRecord[] = [];
      const failedPoolRecords: PoolRecord[] = [];
      const observedUnroutablePoolRecords: PoolRecord[] = [];
      const validationReasonRecords: ValidationReasonPool[] = [];
      let failedPools = 0;
      let observedUnroutablePools = 0;
      const validationReasons: Record<string, number> = {};
      for (const pool of pending) {
        const addr = pool.pool_address.toLowerCase();
        const state = deps.stateCache.get(addr);
        const verdict = deps.validatePoolState(state);
        if (verdict.valid) {
          hydratedAddrs.add(addr);
          hydratedPools.push(pool);
          clearDeferredHydrationRetry(addr);
          clearProtocolRetry(String(pool.protocol ?? "UNKNOWN"));
        } else if (isObservedUnroutableWarmupState(state, verdict)) {
          observedUnroutablePools++;
          observedUnroutablePoolRecords.push(pool);
          clearDeferredHydrationRetry(addr);
          const reason = verdict.reason ?? "observed_unroutable";
          validationReasons[reason] = (validationReasons[reason] ?? 0) + 1;
          validationReasonRecords.push({ pool, outcome: "observed_unroutable", reason });
        } else {
          failedPools++;
          failedPoolRecords.push(pool);
          const reason = verdict.reason ?? "state_not_routable_after_quiet_sweep";
          validationReasons[reason] = (validationReasons[reason] ?? 0) + 1;
          validationReasonRecords.push({ pool, outcome: "failed", reason });
          recordDeferredHydrationFailure(addr, reason);
        }
      }

      const admitted = deps.admitPools(hydratedAddrs);
      const immediateCooldownCohorts = protocolCohortCooldowns(
        pending,
        hydratedPools,
        failedPoolRecords,
        Math.max(2, selection.protocolDiversityCap),
      );
      const protocolCohortCooldownBreakdown = [...immediateCooldownCohorts];
      const immediateCooldownProtocols = new Set(immediateCooldownCohorts.map((cohort) => cohort.protocol));
      const singlePickCohorts = protocolCohortCooldowns(pending, hydratedPools, failedPoolRecords, 1);
      for (const cohort of singlePickCohorts) {
        if (immediateCooldownProtocols.has(cohort.protocol)) {
          protocolZeroYieldStreak.delete(cohort.protocol);
          continue;
        }
        const streak = (protocolZeroYieldStreak.get(cohort.protocol) ?? 0) + 1;
        protocolZeroYieldStreak.set(cohort.protocol, streak);
        if (streak >= 2) {
          protocolCohortCooldownBreakdown.push({
            protocol: cohort.protocol,
            selectedPools: cohort.selectedPools,
            failedPools: cohort.failedPools,
          });
        }
      }
      const protocolCohortCooldownReasonRecords: PendingValidationReasonPool[] = [];
      for (const cohort of protocolCohortCooldownBreakdown) {
        const reason = `zero_routable_protocol_cohort: selected=${cohort.selectedPools} failed=${cohort.failedPools}`;
        recordProtocolCohortFailure(cohort.protocol, reason);
        protocolCohortCooldownReasonRecords.push(
          ...failedPoolRecords.filter((pool) => String(pool.protocol ?? "UNKNOWN") === cohort.protocol).map((pool) => ({ pool, reason })),
        );
      }
      const broadCooldownProtocols = new Set(protocolCohortCooldownBreakdown.map((cohort) => cohort.protocol));
      const coreHubPendingPools = poolsForHubClass(pending, "core_hub", deps.polygonHubTokens, deps.hub4Tokens);
      const coreHubHydratedPools = poolsForHubClass(hydratedPools, "core_hub", deps.polygonHubTokens, deps.hub4Tokens);
      const coreHubFailedPools = poolsForHubClass(failedPoolRecords, "core_hub", deps.polygonHubTokens, deps.hub4Tokens);
      const coreHubProtocolCohortCooldownBreakdown = protocolCohortCooldowns(
        coreHubPendingPools,
        coreHubHydratedPools,
        coreHubFailedPools,
        Math.max(2, selection.protocolDiversityCap),
      ).filter((cohort) => !broadCooldownProtocols.has(cohort.protocol));
      const coreHubProtocolCohortCooldownReasonRecords: PendingValidationReasonPool[] = [];
      for (const cohort of coreHubProtocolCohortCooldownBreakdown) {
        const reason = `zero_routable_core_hub_protocol_cohort: selected=${cohort.selectedPools} failed=${cohort.failedPools}`;
        coreHubProtocolCohortCooldownReasonRecords.push(
          ...coreHubFailedPools.filter((pool) => String(pool.protocol ?? "UNKNOWN") === cohort.protocol).map((pool) => ({ pool, reason })),
        );
      }
      const completionCooldownReasonBreakdown = mergePendingReasonBreakdowns(
        selection.cooldownReasonBreakdown,
        pendingValidationReasonBreakdown(protocolCohortCooldownReasonRecords, deps.polygonHubTokens, deps.hub4Tokens),
        pendingValidationReasonBreakdown(coreHubProtocolCohortCooldownReasonRecords, deps.polygonHubTokens, deps.hub4Tokens),
      );

      deps.log(
        `[runner] Quiet-pool sweep complete: ${hydratedAddrs.size}/${pending.length} routable, ${observedUnroutablePools} observed unroutable.`,
        "info",
        {
          event: "quiet_pool_sweep_complete",
          pendingPools: pending.length,
          pendingBacklogPools: selection.pendingBacklogPools,
          batchSize: selection.batchSize,
          baseBatchSize: selection.baseBatchSize,
          catchupBatchSize: selection.catchupBatchSize,
          catchupThreshold: selection.catchupThreshold,
          catchupActive: selection.catchupActive,
          protocolDiversityCap: selection.protocolDiversityCap,
          unsupportedPools: selection.skippedUnsupportedPools,
          invalidAddressPools: selection.skippedInvalidAddressPools,
          coolingDownPools: selection.skippedCoolingDownPools,
          protocolCoolingDownPools: selection.skippedProtocolCoolingDownPools,
          inFlightPools: selection.skippedInFlightPools,
          skippedObservedUnroutablePools: selection.skippedObservedUnroutablePools,
          coreHubCandidatePools: selection.coreHubCandidatePools,
          routablePools: hydratedAddrs.size,
          observedUnroutablePools,
          failedPools,
          admittedPools: admitted,
          validationReasons,
          protocolCohortCooldownBreakdown,
          coreHubProtocolCohortCooldownBreakdown,
          hydrationYield: hydrationYield(pending.length, hydratedAddrs.size, admitted),
          protocolYieldBreakdown: protocolYieldBreakdown(pending, hydratedPools),
          hubClassYieldBreakdown: hubClassYieldBreakdown(pending, hydratedPools, deps.polygonHubTokens, deps.hub4Tokens),
          validationReasonBreakdown: validationReasonBreakdown(validationReasonRecords, deps.polygonHubTokens, deps.hub4Tokens),
          pendingProtocolBreakdown: selection.pendingProtocolBreakdown,
          pendingHubClassBreakdown: selection.pendingHubClassBreakdown,
          pendingCoreHubProtocolBreakdown: selection.pendingCoreHubProtocolBreakdown,
          pendingValidationReasonBreakdown: selection.pendingValidationReasonBreakdown,
          cooldownReasonBreakdown: completionCooldownReasonBreakdown,
          inFlightProtocolBreakdown: selection.inFlightProtocolBreakdown,
          inFlightHubClassBreakdown: selection.inFlightHubClassBreakdown,
          inFlightCoreHubProtocolBreakdown: selection.inFlightCoreHubProtocolBreakdown,
          selectedProtocolBreakdown: claimedSelectedProtocolBreakdown,
          selectedHubClassBreakdown: claimedSelectedHubClassBreakdown,
          selectedCoreHubProtocolBreakdown: claimedSelectedCoreHubProtocolBreakdown,
          routableProtocolBreakdown: protocolBreakdown(hydratedPools),
          routableCoreHubProtocolBreakdown: protocolBreakdownForHubClass(hydratedPools, "core_hub", deps.polygonHubTokens, deps.hub4Tokens),
          routableHubClassBreakdown: hubClassBreakdown(hydratedPools, deps.polygonHubTokens, deps.hub4Tokens),
          failedProtocolBreakdown: protocolBreakdown(failedPoolRecords),
          failedCoreHubProtocolBreakdown: protocolBreakdownForHubClass(
            failedPoolRecords,
            "core_hub",
            deps.polygonHubTokens,
            deps.hub4Tokens,
          ),
          failedHubClassBreakdown: hubClassBreakdown(failedPoolRecords, deps.polygonHubTokens, deps.hub4Tokens),
          observedUnroutableProtocolBreakdown: protocolBreakdown(observedUnroutablePoolRecords),
          observedUnroutableCoreHubProtocolBreakdown: protocolBreakdownForHubClass(
            observedUnroutablePoolRecords,
            "core_hub",
            deps.polygonHubTokens,
            deps.hub4Tokens,
          ),
          observedUnroutableHubClassBreakdown: hubClassBreakdown(observedUnroutablePoolRecords, deps.polygonHubTokens, deps.hub4Tokens),
          warmupStats,
        },
      );

      if (admitted > 0) {
        await deps.refreshCycles(false);
      }
    } finally {
      finishDeferredHydration(claimedPools);
      quietSweepRunning = false;
    }
  }

  return {
    claimDeferredHydration: beginDeferredHydration,
    releaseDeferredHydration: finishDeferredHydration,
    clearDeferredHydrationRetry,
    recordDeferredHydrationFailure,
    maybeHydrateQuietPools,
  };
}
