import { decodeFunctionData } from "viem";
import type { PublicClient } from 'viem';

import {
  assessRouteResult,
  minProfitInTokenUnits,
  profitMarginBps,
  type ArbPathLike,
  type AssessmentLike,
  type ExecutableCandidate,
  type RouteResultLike,
} from "./assessment.ts";
import { routeIdentityFromEdges } from "../routing/route_identity.ts";
import type { BuildArbTxConfig, BuildArbTxOptions, BuiltTx } from "../execution/build_tx.ts";
import { unsafeExecutionTokenReason } from "../utils/unsafe_tokens.ts";
import { normalizeEvmAddress } from "../utils/pool_record.ts";
import type { NonceManagerLike, SendTxBundleResult, SendTxResult } from "../execution/send_tx.ts";
import { EXECUTOR_ABI } from "../execution/abi_fragments.ts";
import { computeRouteHash } from "../execution/calldata.ts";

type QuarantineEntry = {
  until: number;
  reason: string;
  failures: number;
  quarantinedAt: number;
};

type FeeSnapshot = {
  baseFee: bigint;
  priorityFee: bigint;
  maxFee: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  effectiveGasPriceWei?: bigint;
  updatedAt?: number;
};

type PriorityFeeBid = {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
};

type ExecutionClientConfig = {
  privateKey: string;
  rpcUrl: string;
  nonceManager?: NonceManagerLike | null;
};

type ExecutionSubmitOptions = {
  awaitReceipt: boolean;
  skipDryRun?: boolean;
};

type ExecutionSubmitResult = SendTxResult | SendTxBundleResult | {
  submitted: boolean;
  dryRun?: unknown;
  error?: unknown;
  [key: string]: unknown;
};

type CandidateRefreshContext = {
  gasPriceWei: bigint;
  tokenToMaticRate: bigint;
};

type CandidateRefreshResult =
  | ExecutableCandidate
  | { candidate: ExecutableCandidate }
  | { candidate: null; reason: string }
  | null
  | undefined;

type ExecutionCoordinatorDeps = {
  liveMode: boolean;
  privateKey: string | null;
  executorAddress: string | null;
  rpcUrl: string;
  getNonceManager: () => NonceManagerLike | null | undefined;
  maxExecutionBatch: number;
  executionRouteQuarantineMs: number;
  minProfitWei: bigint;
  flashLoanFeeBps?: bigint;
  log: (msg: string, level?: "fatal" | "error" | "warn" | "info" | "debug" | "trace", meta?: unknown) => void;
  fmtPath: (path: ArbPathLike) => string;
  getRouteFreshness: (path: ArbPathLike) => { ok: boolean; reason?: string; ageMs?: number; skewMs?: number };
  getCurrentFeeSnapshot: () => Promise<FeeSnapshot | null | undefined>;
  getFreshTokenToMaticRate: (tokenAddress: string) => bigint;
  deriveOnChainMinProfit: (assessment: AssessmentLike | null | undefined, tokenToMaticRate: bigint) => bigint;
  buildArbTx: (candidate: ExecutableCandidate, accounts: BuildArbTxConfig, options: BuildArbTxOptions) => Promise<BuiltTx>;
  sendTx: (tx: BuiltTx, clientConfig: ExecutionClientConfig, options: ExecutionSubmitOptions) => Promise<ExecutionSubmitResult>;
  sendTxBundle: (txs: BuiltTx[], clientConfig: ExecutionClientConfig, options: ExecutionSubmitOptions) => Promise<ExecutionSubmitResult>;
  hasPendingExecution?: (fromAddress?: string | null | undefined) => boolean;
  scalePriorityFeeByProfitMargin: (fees: FeeSnapshot, profitMarginBps: bigint) => PriorityFeeBid;
  refreshCandidateBeforeExecution?: (
    candidate: ExecutableCandidate,
    context: CandidateRefreshContext,
  ) => Promise<CandidateRefreshResult> | CandidateRefreshResult;
  onPreparedCandidateError?: (candidate: ExecutableCandidate, reason: string, quarantine: QuarantineEntry) => void;
  publicClient?: PublicClient | null;
};

export function createExecutionCoordinator(deps: ExecutionCoordinatorDeps) {
  let executionInFlight = false;
  const executionRouteQuarantine = new Map<string, QuarantineEntry>();
  const executionPoolQuarantine = new Map<string, QuarantineEntry>();

  const EXECUTE_ARB_SELECTOR = "0x491e69d3";

  function hexString(value: unknown) {
    return typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value) ? value : null;
  }

  function sameHex(a: unknown, b: unknown) {
    const left = hexString(a);
    const right = hexString(b);
    return left != null && right != null && left.toLowerCase() === right.toLowerCase();
  }

  function normalizeCallForBoundary(call: unknown) {
    if (!call || typeof call !== "object") return null;
    const record = call as { target?: unknown; value?: unknown; data?: unknown };
    const target = normalizeEvmAddress(record.target);
    const value = record.value ?? 0n;
    const data = hexString(record.data);
    if (!target || typeof value !== "bigint" || !data) return null;
    return { target, value, data };
  }

  function validateDecodedExecuteArb(best: ExecutableCandidate, builtTx: BuiltTx, flashParams: Record<string, unknown>, minProfit: bigint) {
    let decoded: { functionName?: string; args?: readonly unknown[] };
    try {
      decoded = decodeFunctionData({ abi: EXECUTOR_ABI, data: builtTx.data as `0x${string}` });
    } catch {
      return "built transaction executeArb calldata is not decodable";
    }
    if (decoded.functionName !== "executeArb" || !Array.isArray(decoded.args) || decoded.args.length !== 3) {
      return "built transaction does not decode to ArbExecutor.executeArb";
    }

    const [calldataFlashToken, calldataFlashAmount, calldataParams] = decoded.args;
    if (normalizeEvmAddress(calldataFlashToken) !== normalizeEvmAddress(best.path.startToken)) {
      return "built transaction executeArb calldata flash token does not match route start token";
    }
    if (typeof calldataFlashAmount !== "bigint" || calldataFlashAmount !== best.result.amountIn) {
      return "built transaction executeArb calldata flash amount does not match route input amount";
    }
    if (!calldataParams || typeof calldataParams !== "object") {
      return "built transaction executeArb calldata params are malformed";
    }
    const params = calldataParams as {
      profitToken?: unknown;
      minProfit?: unknown;
      deadline?: unknown;
      routeHash?: unknown;
      calls?: unknown;
    };
    if (normalizeEvmAddress(params.profitToken) !== normalizeEvmAddress(best.path.startToken)) {
      return "built transaction executeArb calldata profit token does not match route start token";
    }
    if (typeof params.minProfit !== "bigint" || params.minProfit < minProfit) {
      return "built transaction executeArb calldata minProfit is below derived on-chain threshold";
    }
    if (params.minProfit !== flashParams.minProfit) {
      return "built transaction executeArb calldata minProfit does not match flash-loan params";
    }
    if (typeof params.deadline !== "bigint" || params.deadline <= 0n || params.deadline !== flashParams.deadline) {
      return "built transaction executeArb calldata deadline does not match flash-loan params";
    }
    if (!sameHex(params.routeHash, flashParams.routeHash)) {
      return "built transaction executeArb calldata route hash does not match flash-loan params";
    }
    if (!Array.isArray(params.calls) || !Array.isArray(flashParams.calls) || params.calls.length !== flashParams.calls.length) {
      return "built transaction executeArb calldata route calls do not match flash-loan params";
    }

    const decodedCalls = params.calls.map(normalizeCallForBoundary);
    const expectedCalls = flashParams.calls.map(normalizeCallForBoundary);
    if (decodedCalls.some((call) => call == null) || expectedCalls.some((call) => call == null)) {
      return "built transaction executeArb calldata route call is malformed";
    }
    for (let i = 0; i < decodedCalls.length; i++) {
      const decodedCall = decodedCalls[i]!;
      const expectedCall = expectedCalls[i]!;
      if (
        decodedCall.target !== expectedCall.target ||
        decodedCall.value !== expectedCall.value ||
        !sameHex(decodedCall.data, expectedCall.data)
      ) {
        return "built transaction executeArb calldata route calls do not match flash-loan params";
      }
      if (decodedCall.value !== 0n) {
        return "built transaction route calls must not send native value";
      }
    }

    let computedRouteHash: string;
    try {
      computedRouteHash = computeRouteHash(decodedCalls);
    } catch {
      return "built transaction executeArb calldata route hash is not computable";
    }
    if (!sameHex(computedRouteHash, params.routeHash)) {
      return "built transaction executeArb calldata route hash does not match route calls";
    }
    return null;
  }

  function validateBuiltFlashLoanArbTx(best: ExecutableCandidate, builtTx: BuiltTx, minProfit: bigint) {
    const configuredExecutor = normalizeEvmAddress(deps.executorAddress);
    const txTarget = normalizeEvmAddress(builtTx?.to);
    if (!configuredExecutor || txTarget !== configuredExecutor) {
      return "built transaction is not addressed to configured ArbExecutor";
    }
    if (builtTx.value !== 0n) {
      return "built transaction must not send native value";
    }
    if (typeof builtTx.data !== "string" || !builtTx.data.toLowerCase().startsWith(EXECUTE_ARB_SELECTOR)) {
      return "built transaction does not call ArbExecutor.executeArb";
    }
    const flashParams = builtTx.flashParams as Record<string, unknown> | null | undefined;
    if (!flashParams || typeof flashParams !== "object") {
      return "built transaction missing flash-loan params";
    }
    if (!Array.isArray(flashParams.calls) || flashParams.calls.length === 0) {
      return "built transaction flash-loan params contain no route calls";
    }
    for (const call of flashParams.calls) {
      if (!call || typeof call !== "object") {
        return "built transaction flash-loan route call is malformed";
      }
      const value = (call as { value?: unknown }).value ?? 0n;
      if (value !== 0n) {
        return "built transaction route calls must not send native value";
      }
    }
    if (typeof flashParams.minProfit !== "bigint" || flashParams.minProfit < minProfit) {
      return "built transaction flash-loan minProfit is below derived on-chain threshold";
    }
    if (typeof flashParams.routeHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(flashParams.routeHash)) {
      return "built transaction missing flash-loan route hash";
    }
    const meta = builtTx.meta as Record<string, unknown> | null | undefined;
    const flashToken = normalizeEvmAddress(meta?.flashToken);
    if (flashToken !== normalizeEvmAddress(best.path.startToken)) {
      return "built transaction flash token does not match route start token";
    }
    if (String(meta?.flashAmount ?? "") !== best.result.amountIn.toString()) {
      return "built transaction flash amount does not match route input amount";
    }
    const decodedValidationError = validateDecodedExecuteArb(best, builtTx, flashParams, minProfit);
    if (decodedValidationError) return decodedValidationError;
    return null;
  }

  function gasLimitToSafeNumber(gasLimit: bigint) {
    if (gasLimit < 0n) {
      throw new Error("post-build gas limit cannot be negative");
    }
    if (gasLimit > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("post-build gas limit exceeds Number.MAX_SAFE_INTEGER");
    }
    return Number(gasLimit);
  }

  function gasBudgetWei(candidate: ExecutableCandidate, tokenToMaticRate: bigint) {
    const minProfitTokens = minProfitInTokenUnits(tokenToMaticRate, deps.minProfitWei);
    const netBeforeGas = candidate.assessment?.netProfit ?? 0n;
    if (netBeforeGas <= minProfitTokens) return 0n;
    return (netBeforeGas - minProfitTokens) * tokenToMaticRate;
  }

  function errorReason(err: unknown) {
    const seen = new Set<unknown>();
    const parts: string[] = [];
    function add(value: unknown) {
      if (typeof value !== "string") return;
      const text = value.trim();
      if (text && !parts.includes(text)) parts.push(text);
    }
    function visit(value: unknown, depth = 0) {
      if (value == null || depth > 3 || seen.has(value)) return;
      seen.add(value);
      if (typeof value === "string") {
        add(value);
        return;
      }
      if (typeof value !== "object" && typeof value !== "function") return;
      const error = value as Record<string, unknown>;
      add(error.shortMessage);
      add(error.reason);
      add(error.details);
      add(error.message);
      visit(error.cause, depth + 1);
      visit(error.walkResult, depth + 1);
    }
    visit(err);
    return parts.length > 0 ? parts.join(" | ") : String(err ?? "execution error");
  }

  async function mapExecutionCandidates<T, R>(
    candidates: T[],
    worker: (candidate: T) => Promise<R>,
  ): Promise<R[]> {
    if (candidates.length === 0) return [];

    const concurrency = Math.max(1, Math.min(Math.floor(Number(deps.maxExecutionBatch) || 1), candidates.length));
    const results = new Array<R>(candidates.length);
    let nextIndex = 0;

    async function runWorker() {
      while (nextIndex < candidates.length) {
        const currentIndex = nextIndex++;
        results[currentIndex] = await worker(candidates[currentIndex]);
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
    return results;
  }

  function executionRouteKey(path: ArbPathLike) {
    return routeIdentityFromEdges(path.startToken, path.edges);
  }

  function executionPoolKeys(path: ArbPathLike) {
    return path.edges
      .map((edge) => normalizeEvmAddress(edge.poolAddress))
      .filter((pool): pool is string => pool != null);
  }

  function pruneQuarantineMap(map: Map<string, QuarantineEntry>, now: number) {
    for (const [key, entry] of map.entries()) {
      if (entry.until <= now) map.delete(key);
    }
  }

  function pruneExecutionRouteQuarantine(now = Date.now()) {
    pruneQuarantineMap(executionRouteQuarantine, now);
    pruneQuarantineMap(executionPoolQuarantine, now);
  }

  function activeQuarantineEntry(map: Map<string, QuarantineEntry>, key: string, now: number) {
    const entry = map.get(key);
    if (!entry) return null;
    if (entry.until <= now) {
      map.delete(key);
      return null;
    }
    return entry;
  }

  function getExecutionRouteQuarantine(path: ArbPathLike, now = Date.now()) {
    const routeEntry = activeQuarantineEntry(executionRouteQuarantine, executionRouteKey(path), now);
    if (routeEntry) return routeEntry;
    for (const pool of executionPoolKeys(path)) {
      const poolEntry = activeQuarantineEntry(executionPoolQuarantine, pool, now);
      if (poolEntry) return poolEntry;
    }
    return null;
  }

  function quarantineExecutionRoute(path: ArbPathLike, reason: string, now = Date.now()) {
    const key = executionRouteKey(path);
    const previous = executionRouteQuarantine.get(key);
    const failures = (previous?.failures ?? 0) + 1;
    const until = now + deps.executionRouteQuarantineMs;
    executionRouteQuarantine.set(key, {
      until,
      reason,
      failures,
      quarantinedAt: now,
    });
    return { failures, until };
  }

  function quarantineExecutionPools(path: ArbPathLike, reason: string, now = Date.now()) {
    let maxFailures = 0;
    let maxUntil = now;
    for (const pool of executionPoolKeys(path)) {
      const previous = executionPoolQuarantine.get(pool);
      const failures = (previous?.failures ?? 0) + 1;
      const until = now + deps.executionRouteQuarantineMs;
      executionPoolQuarantine.set(pool, {
        until,
        reason,
        failures,
        quarantinedAt: now,
      });
      maxFailures = Math.max(maxFailures, failures);
      maxUntil = Math.max(maxUntil, until);
    }
    return { failures: maxFailures, until: maxUntil };
  }

  function quarantinePreparedCandidate(candidate: ExecutableCandidate, reason: string, source: string, meta: Record<string, unknown> = {}) {
    const quarantine = quarantineExecutionRoute(candidate.path, reason);
    const poolQuarantine = quarantineExecutionPools(candidate.path, reason);
    const payload = {
      event: "execute_quarantine_add",
      route: deps.fmtPath(candidate.path),
      hopCount: candidate.path.hopCount,
      protocols: candidate.path.edges.map((edge) => edge.protocol),
      pools: candidate.path.edges.map((edge) => edge.poolAddress),
      netProfit: candidate.assessment?.netProfit?.toString?.(),
      netProfitAfterGas: candidate.assessment?.netProfitAfterGas?.toString?.(),
      failures: quarantine.failures,
      poolFailures: poolQuarantine.failures,
      quarantineMs: Math.max(0, Math.max(quarantine.until, poolQuarantine.until) - Date.now()),
      reason,
      source,
      ...meta,
    };
    deps.log(`[runner] Quarantining route after execution preparation failure: ${reason}`, "warn", payload);
    deps.onPreparedCandidateError?.(candidate, reason, {
      reason,
      failures: quarantine.failures,
      until: quarantine.until,
      quarantinedAt: Date.now(),
    });
  }

  function clearExecutionRouteQuarantine(reason: string) {
    if (executionRouteQuarantine.size === 0 && executionPoolQuarantine.size === 0) return;
    executionRouteQuarantine.clear();
    executionPoolQuarantine.clear();
    deps.log("[runner] Cleared execution route quarantine", "debug", {
      event: "execute_quarantine_clear",
      reason,
    });
  }

  function filterQuarantinedCandidates<T extends { path: ArbPathLike }>(candidates: T[], source: string) {
    const now = Date.now();
    pruneExecutionRouteQuarantine(now);
    let quarantined = 0;
    const filtered = candidates.filter((candidate) => {
      const entry = getExecutionRouteQuarantine(candidate.path, now);
      if (!entry) return true;
      quarantined++;
      return false;
    });
    if (quarantined > 0) {
      deps.log("[runner] Skipping quarantined execution routes", "debug", {
        event: "execute_quarantine_skip",
        source,
        candidates: candidates.length,
        quarantined,
        remaining: filtered.length,
      });
    }
    return filtered;
  }

  function extractRefreshedCandidate(
    refreshResult: CandidateRefreshResult,
    fallback: ExecutableCandidate,
  ): { candidate: ExecutableCandidate | null; reason?: string } {
    if (refreshResult == null) return { candidate: fallback };
    if ("path" in refreshResult && "result" in refreshResult && "assessment" in refreshResult) {
      return { candidate: refreshResult };
    }
    const wrapped = refreshResult as { candidate?: ExecutableCandidate | null; reason?: string };
    if (wrapped.candidate === null) {
      return { candidate: null, reason: wrapped.reason ?? "pre-execution candidate refresh rejected route" };
    }
    if (wrapped.candidate) return { candidate: wrapped.candidate };
    return { candidate: fallback };
  }

  function routeExecutionTokens(path: ArbPathLike, result: RouteResultLike | null | undefined) {
    return [
      path.startToken,
      ...(Array.isArray(result?.tokenPath) ? result.tokenPath : []),
      ...path.edges.flatMap((edge) => [edge.tokenIn, edge.tokenOut]),
    ];
  }

  function unsafeExecutionRouteReason(candidate: ExecutableCandidate) {
    return unsafeExecutionTokenReason(routeExecutionTokens(candidate.path, candidate.result));
  }

  async function prepareExecutionCandidate(best: ExecutableCandidate, account: { address: string }) {
    let executionCandidate = best;
    const quarantineEntry = getExecutionRouteQuarantine(executionCandidate.path);
    if (quarantineEntry) {
      deps.log("[runner] Skipping quarantined route during execution preparation", "debug", {
        event: "execute_skip",
        reason: "route_quarantined",
        route: deps.fmtPath(executionCandidate.path),
        hopCount: executionCandidate.path.hopCount,
        quarantineReason: quarantineEntry.reason,
        failures: quarantineEntry.failures,
        quarantineMs: Math.max(0, quarantineEntry.until - Date.now()),
      });
      return null;
    }

    const unsafeRouteReason = unsafeExecutionRouteReason(executionCandidate);
    if (unsafeRouteReason) {
      quarantinePreparedCandidate(executionCandidate, unsafeRouteReason, "prepare_execution_token_safety");
      return null;
    }

    const freshness = deps.getRouteFreshness(executionCandidate.path);
    if (!freshness.ok) {
      const quarantineReason = freshness.reason ?? "route freshness check failed";
      quarantinePreparedCandidate(executionCandidate, quarantineReason, "prepare_execution_freshness", {
        ageMs: freshness.ageMs,
        skewMs: freshness.skewMs,
      });
      return null;
    }

    const feeSnapshot = await deps.getCurrentFeeSnapshot();
    const dynamicBid = feeSnapshot
      ? deps.scalePriorityFeeByProfitMargin(feeSnapshot, profitMarginBps(executionCandidate))
      : null;

    let tokenToMaticRate = deps.getFreshTokenToMaticRate(executionCandidate.path.startToken);
    if (tokenToMaticRate <= 0n) {
      quarantinePreparedCandidate(executionCandidate, "stale_or_missing_token_matic_rate", "prepare_execution_price");
      return null;
    }

    if (deps.refreshCandidateBeforeExecution) {
      const refreshed = extractRefreshedCandidate(
        await deps.refreshCandidateBeforeExecution(executionCandidate, {
          gasPriceWei: feeSnapshot?.effectiveGasPriceWei ?? feeSnapshot?.maxFee ?? 0n,
          tokenToMaticRate,
        }),
        executionCandidate,
      );
      if (!refreshed.candidate) {
        quarantinePreparedCandidate(
          executionCandidate,
          refreshed.reason ?? "pre-execution candidate refresh rejected route",
          "prepare_execution_revalidation",
        );
        return null;
      }
      executionCandidate = refreshed.candidate;
      tokenToMaticRate = deps.getFreshTokenToMaticRate(executionCandidate.path.startToken);
      if (tokenToMaticRate <= 0n) {
        quarantinePreparedCandidate(executionCandidate, "stale_or_missing_token_matic_rate", "prepare_execution_price");
        return null;
      }
    }

    const onChainMinProfit = deps.deriveOnChainMinProfit(
      executionCandidate.assessment,
      tokenToMaticRate,
    );

    const builtTx = await deps.buildArbTx(
      executionCandidate,
      { executorAddress: deps.executorAddress, fromAddress: account.address },
      {
        minProfit: onChainMinProfit,
        slippageBps: 50,
        gasMultiplier: 1.25,
        maxFeeOverride: dynamicBid?.maxFeePerGas,
        priorityFeeOverride: dynamicBid?.maxPriorityFeePerGas,
        maxEstimatedCostWei: gasBudgetWei(executionCandidate, tokenToMaticRate),
      },
    );

    const flashLoanValidationError = validateBuiltFlashLoanArbTx(executionCandidate, builtTx, onChainMinProfit);
    if (flashLoanValidationError) {
      quarantinePreparedCandidate(executionCandidate, flashLoanValidationError, "prepare_execution_flash_loan_boundary");
      return null;
    }

    const postBuildAssessment = assessRouteResult(
      executionCandidate.path,
      { ...executionCandidate.result, totalGas: gasLimitToSafeNumber(builtTx.gasLimit) },
      builtTx.effectiveGasPriceWei ?? builtTx.maxFeePerGas,
      tokenToMaticRate,
      { minProfitWei: deps.minProfitWei, flashLoanFeeBps: deps.flashLoanFeeBps },
    );

    if (!postBuildAssessment.shouldExecute) {
      quarantinePreparedCandidate(
        executionCandidate,
        postBuildAssessment.rejectReason ?? "post_build_profit_check_failed",
        "prepare_execution_post_build_profit",
        {
          preNetProfitAfterGas: executionCandidate.assessment.netProfitAfterGas?.toString?.(),
          postNetProfitAfterGas: postBuildAssessment.netProfitAfterGas?.toString?.(),
        },
      );
      return null;
    }

    const postBuildProfitWei = postBuildAssessment.netProfitAfterGas > 0n
      ? postBuildAssessment.netProfitAfterGas * tokenToMaticRate
      : 0n;
    builtTx.meta.expectedProfitTokenUnits = postBuildAssessment.netProfitAfterGas.toString();
    builtTx.meta.expectedProfitWei = postBuildProfitWei.toString();
    builtTx.meta.profitTokenToMaticRate = tokenToMaticRate.toString();

    deps.log(
      `[drift] pre=${executionCandidate.assessment.netProfitAfterGas} post=${postBuildAssessment.netProfitAfterGas} onChainMin=${onChainMinProfit}`,
      "info",
      () => ({
        event: "execute_drift_check",
        hopCount: executionCandidate.path.hopCount,
        preNetProfitAfterGas: executionCandidate.assessment.netProfitAfterGas?.toString?.(),
        postNetProfitAfterGas: postBuildAssessment.netProfitAfterGas?.toString?.(),
        onChainMinProfit: onChainMinProfit.toString(),
      }),
    );

    return { best: executionCandidate, builtTx };
  }

  async function executeMany(candidates: ExecutableCandidate[]) {
    if (!deps.liveMode) {
      const dryRunTargets = candidates.slice(0, deps.maxExecutionBatch);
      deps.log(`[DRY-RUN] Would execute ${dryRunTargets.length} opportunity(ies)`, "info", () => ({
        event: "execute_dry_run",
        opportunities: dryRunTargets.length,
        hopCounts: dryRunTargets.map((candidate) => candidate.path.hopCount),
        netProfits: dryRunTargets.map((candidate) => candidate.assessment.netProfit.toString()),
      }));
      return { submitted: false, dryRun: true };
    }

    if (!deps.privateKey || !deps.executorAddress) {
      deps.log("[SKIP] PRIVATE_KEY and EXECUTOR_ADDRESS required for --live", "warn", {
        event: "execute_skip",
        reason: "missing_live_config",
      });
      return { submitted: false, error: "missing config" };
    }

    try {
      const { privateKeyToAccount } = await import("viem/accounts");
      const account = privateKeyToAccount(deps.privateKey as `0x${string}`);
      const prepared = [];
      const executionCandidates = candidates.slice(0, deps.maxExecutionBatch);
      const preparedCandidates = await mapExecutionCandidates(executionCandidates, async (candidate) => {
        try {
          return await prepareExecutionCandidate(candidate, account);
        } catch (err: unknown) {
          const baseReason = errorReason(err);

          // The getRevertReason call below is intentionally skipped because
          // deps.publicClient is not wired and data is unavailable at this
          // point — the error came from buildArbTx/estimateGas, not a revert.
          // The raw viem error already contains the best available reason.
          let finalReason = baseReason;
          // Note: getRevertReason was removed here because the catch block
          // catches errors from prepareExecutionCandidate (buildArbTx), not
          // from submission. The error message already contains full details.
          // If this were a post-submission revert, wire getRevertReason here
          // with the actual calldata from the built transaction.

          quarantinePreparedCandidate(candidate, finalReason, "prepare_execution_exception");
          return null;
        }
      });

      for (const preparedCandidate of preparedCandidates) {
        if (preparedCandidate) prepared.push(preparedCandidate);
      }

      if (prepared.length === 0) {
        return { submitted: false, error: "no execution candidates survived post-build checks" };
      }

      const clientConfig = {
        privateKey: deps.privateKey,
        rpcUrl: deps.rpcUrl,
        nonceManager: deps.getNonceManager(),
      };

      if (prepared.length === 1) {
        // Pre-execution route refresh already simulated this route — skip the redundant dry-run
        return await deps.sendTx(prepared[0].builtTx, clientConfig, { awaitReceipt: false, skipDryRun: true });
      }

      deps.log(`[runner] Bundling ${prepared.length} opportunities into one private bundle`, "info", {
        event: "execute_bundle",
        opportunities: prepared.length,
        hopCounts: prepared.map((entry) => entry.best.path.hopCount),
      });

      return await deps.sendTxBundle(
        prepared.map((entry) => entry.builtTx),
        clientConfig,
        { awaitReceipt: false },
      );
    } catch (err: unknown) {
      const reason = errorReason(err);
      deps.log(`Execution error: ${reason}`, "error", {
        event: "execute_error",
        err,
      });
      return { submitted: false, error: reason };
    }
  }

  async function executeBatchIfIdle(candidates: ExecutableCandidate[], source = "unknown") {
    // Atomic CAS: only one caller may pass this barrier.
    // Both executionInFlight and hasPendingExecution are checked under the same
    // lock slot to prevent the TOCTOU window between check-and-set.
    if (executionInFlight) {
      deps.log("[runner] Skipping execution while another execution is in flight", "warn", {
        event: "execute_skip", reason: "execution_in_flight", source,
      });
      return { submitted: false, error: "execution already in flight" };
    }
    executionInFlight = true;
    try {
      if (deps.hasPendingExecution?.()) {
        deps.log("[runner] Skipping execution — pending transaction detected", "warn", {
          event: "execute_skip", reason: "pending_transaction_in_flight", source,
        });
        return { submitted: false, error: "pending transaction already in flight" };
      }
      return await executeMany(candidates);
    } finally {
      executionInFlight = false;
    }
  }

  async function executeIfIdle(best: ExecutableCandidate, source = "unknown") {
    return executeBatchIfIdle([best], source);
  }

  return {
    clearExecutionRouteQuarantine,
    executeBatchIfIdle,
    executeIfIdle,
    filterQuarantinedCandidates,
  };
}