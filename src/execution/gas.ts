/**
 * src/execution/gas.ts — Gas estimation and fee management
 *
 * Optimized for HFT:
 *   - Uses the shared RPC manager for multi-endpoint switching.
 *   - Automatically fails over to an alternate endpoint on rate-limits / errors.
 *   - Implements a background Gas Oracle to provide zero-latency fee data.
 *
 * RPC client routing:
 *   client           → dynamicPublicClient (shared rotation pool, general reads)
 *   executionClient  → EXECUTION_RPC_URL   (dedicated, no fallback, for nonce/receipt)
 *   gasOracleClient  → GAS_ESTIMATION_RPC_URL (dedicated, for fee polling + estimateGas)
 */

import { dynamicPublicClient } from "../utils/rpc_manager.ts";
import { gasPriceGwei } from "../utils/metrics.ts";
import { createGasEstimationClient, createExecutionReadClient } from "../config/rpc_env.ts";

// ─── Clients ──────────────────────────────────────────────────────────────────
// The dynamic proxy delegates to the best available RPC endpoint for general reads.
export const client = dynamicPublicClient;

// Fix #4: use EXECUTION_RPC_URL (via rpc_env.ts) for nonce fetches and receipt
// polling — not the general-purpose POLYGON_RPC from config/index.ts.
export const executionClient = createExecutionReadClient();

// Fix #3: dedicated client for gas oracle fee polling. Keeps fee-history calls
// off the shared pool so they don't poison endpoint health scores.
const gasOracleClient = createGasEstimationClient();

type GasEstimateCacheEntry = {
  estimate: bigint;
  updatedAt: number;
};

const gasEstimateCache = new Map<string, GasEstimateCacheEntry>();
const GAS_ORACLE_MAX_AGE_MS = 15_000;
const GAS_MULTIPLIER_SCALE = 10_000n;
const GAS_ESTIMATE_CACHE_TTL_MS = 120_000;
const GAS_ESTIMATE_CACHE_MAX_ENTRIES = 2_048;

export type FeeSnapshot = {
  baseFee: bigint;
  priorityFee: bigint;
  maxFee: bigint;
  updatedAt?: number;
};

export type GasTxRequest = {
  to?: string;
  data?: string;
  value?: bigint;
};

type GasOracleFreshnessOptions = {
  maxAgeMs?: number;
  allowStaleOnFailure?: boolean;
  now?: number;
};

type PriorityFeeScalingOptions = {
  minMultiplierBps?: bigint | number | string;
  maxMultiplierBps?: bigint | number | string;
  fullRampMarginBps?: bigint | number | string;
};

export type RecommendGasParamsOptions = {
  gasMultiplier?: number;
  maxFeeOverride?: bigint;
  priorityFeeOverride?: bigint;
  gasEstimateCacheKey?: string;
  forceRefreshEstimate?: boolean;
  requireFreshFees?: boolean;
  gasOracleMaxAgeMs?: number;
  allowStaleFeesOnRefreshFailure?: boolean;
  maxEstimatedCostWei?: bigint | null;
  gasEstimateCacheTtlMs?: number;
  gasEstimateCacheMaxEntries?: number;
  now?: number;
  estimateGasFn?: (tx: GasTxRequest, fromAddress: string) => Promise<unknown> | unknown;
  feeSnapshot?: FeeSnapshot | null;
};

export type RecommendedGasParams = {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gasLimit: bigint;
  effectiveGasPriceWei: bigint;
  estimatedCostWei: bigint;
  maxCostWei: bigint;
};

type BigIntInput = bigint | number | string | boolean;

function maxBigInt(a: bigint, b: bigint) {
  return a > b ? a : b;
}

function normalizeFeeSnapshot(fees: FeeSnapshot) {
  if (!fees) throw new Error("fee snapshot is required");
  const baseFee = BigInt(fees.baseFee);
  const priorityFee = BigInt(fees.priorityFee);
  const maxFee = BigInt(fees.maxFee);
  if (baseFee < 0n) throw new Error("baseFee must be >= 0");
  if (priorityFee < 0n) throw new Error("priorityFee must be >= 0");
  if (maxFee < 0n) throw new Error("maxFee must be >= 0");
  if (maxFee < baseFee) throw new Error("maxFee must be >= baseFee");
  return { baseFee, priorityFee, maxFee };
}

export function effectiveGasPriceWei(fees: FeeSnapshot) {
  const normalized = normalizeFeeSnapshot(fees);
  const effective = normalized.baseFee + normalized.priorityFee;
  return effective > normalized.maxFee ? normalized.maxFee : effective;
}

export function capGasFeesToBudget(
  fees: {
    baseFee: bigint;
    maxPriorityFeePerGas: bigint;
    maxFeePerGas: bigint;
  },
  gasLimit: bigint,
  maxEstimatedCostWei: bigint | null | undefined,
) {
  if (maxEstimatedCostWei == null) return fees;
  if (maxEstimatedCostWei < 0n) {
    throw new Error("maxEstimatedCostWei must be >= 0");
  }
  if (gasLimit <= 0n) {
    throw new Error("gasLimit must be > 0 when applying a gas cost budget");
  }

  const maxAffordableGasPrice = maxEstimatedCostWei / gasLimit;
  if (maxAffordableGasPrice < fees.baseFee) {
    throw new Error("gas cost budget is below current baseFee");
  }

  const maxFeePerGas = fees.maxFeePerGas > maxAffordableGasPrice ? maxAffordableGasPrice : fees.maxFeePerGas;
  const maxPriorityFromBudget = maxAffordableGasPrice - fees.baseFee;
  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas > maxPriorityFromBudget ? maxPriorityFromBudget : fees.maxPriorityFeePerGas;

  return {
    maxFeePerGas,
    maxPriorityFeePerGas,
  };
}

function bufferedGasLimit(gasEstimate: bigint, gasMultiplier: number) {
  if (!Number.isFinite(gasMultiplier) || gasMultiplier <= 0) {
    throw new Error("gasMultiplier must be a finite positive number");
  }
  if (gasEstimate < 0n) {
    throw new Error("gasEstimate must be non-negative");
  }
  const multiplierBpsNumber = Math.ceil(gasMultiplier * Number(GAS_MULTIPLIER_SCALE));
  if (!Number.isSafeInteger(multiplierBpsNumber)) {
    throw new Error("gasMultiplier is too large");
  }
  const multiplierBps = BigInt(multiplierBpsNumber);
  return (gasEstimate * multiplierBps + GAS_MULTIPLIER_SCALE - 1n) / GAS_MULTIPLIER_SCALE;
}

function normalizeGasEstimate(value: unknown) {
  if (value == null) return null;
  if (typeof value === "bigint") {
    if (value <= 0n) return null;
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      return null;
    }
    return BigInt(value);
  }
  if (typeof value !== "string" && typeof value !== "boolean") {
    return null;
  }
  try {
    const normalized = BigInt(value as BigIntInput);
    if (normalized <= 0n) return null;
    return normalized;
  } catch {
    return null;
  }
}

function normalizeCacheTtlMs(value: unknown) {
  const ttl = Number(value);
  if (!Number.isFinite(ttl) || ttl < 0) {
    throw new Error("gasEstimateCacheTtlMs must be a finite non-negative number");
  }
  return ttl;
}

function normalizeCacheMaxEntries(value: unknown) {
  const maxEntries = Number(value);
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new Error("gasEstimateCacheMaxEntries must be a positive safe integer");
  }
  return maxEntries;
}

function normalizeNowMs(value: unknown) {
  const now = Number(value);
  if (!Number.isFinite(now) || now < 0) {
    throw new Error("now must be a finite non-negative number");
  }
  return now;
}

function getCachedGasEstimate(key: string, now: number, ttlMs: number) {
  const entry = gasEstimateCache.get(key);
  if (!entry) return null;
  if (now - entry.updatedAt > ttlMs) {
    gasEstimateCache.delete(key);
    return null;
  }
  gasEstimateCache.delete(key);
  gasEstimateCache.set(key, entry);
  return entry.estimate;
}

function rememberGasEstimate(key: string, estimate: bigint, now: number, maxEntries: number) {
  gasEstimateCache.delete(key);
  gasEstimateCache.set(key, { estimate, updatedAt: now });
  while (gasEstimateCache.size > maxEntries) {
    const oldestKey = gasEstimateCache.keys().next().value;
    if (oldestKey == null) break;
    gasEstimateCache.delete(oldestKey);
  }
}

// ─── Gas Oracle ───────────────────────────────────────────────

/**
 * Background Gas Oracle to keep latest fee data ready for the hot path.
 */
class GasOracle {
  baseFee: bigint;
  priorityFee: bigint;
  maxFee: bigint;
  updatedAt: number;
  tokenPrices: Map<string, bigint>;
  private _interval: ReturnType<typeof setInterval> | null;
  private _updatePromise: Promise<void> | null;

  constructor() {
    this.baseFee = 30n * 10n ** 9n;
    this.priorityFee = 30n * 10n ** 9n;
    this.maxFee = 90n * 10n ** 9n;
    this.updatedAt = 0;
    this.tokenPrices = new Map();
    this._interval = null;
    this._updatePromise = null;
  }

  /**
   * Start background polling for fee data.
   */
  start(intervalMs = 2000) {
    if (this._interval) return;
    void this.update();
    this._interval = setInterval(() => this.update(), intervalMs);
    this._interval.unref?.();
  }

  /**
   * Update the latest fee data from the network.
   *
   * Strategy:
   *   1. Fetch the latest block to get baseFeePerGas.
   *   2. Call eth_feeHistory (10 blocks, p25/p50/p75 reward percentiles) to
   *      derive a data-driven priority fee.  Falls back to the previous value
   *      if the endpoint does not support eth_feeHistory.
   *
   * Polygon specifics:
   *   - Blocks arrive every ~2 s; polling every 1–2 s is sufficient.
   *   - Base fee on Polygon is typically 30–200 gwei.
   *   - Priority fee is almost always 30 gwei (Polygon doesn't use EIP-1559
   *     priority fee the same way Ethereum does, but validators still accept it).
   */
  async update() {
    if (this._updatePromise) {
      return this._updatePromise;
    }

    this._updatePromise = (async () => {
      try {
        // Fix #3: use dedicated gasOracleClient (GAS_ESTIMATION_RPC_URL) instead
        // of executeWithRpcRetry which rotates through the shared pool and
        // contaminates endpoint health scores with fee-polling traffic.
        const block = await gasOracleClient.getBlock({ blockTag: "latest" });
        this.baseFee = block.baseFeePerGas ?? 30n * 10n ** 9n;

        // ── Priority fee via eth_feeHistory ──────────────────────
        try {
          const feeHistory = (await gasOracleClient.getFeeHistory({
            blockCount: 10,
            rewardPercentiles: [25, 50, 75],
            blockTag: "latest",
          })) as { reward?: Array<Array<BigIntInput | null | undefined>> };

          // Extract p50 (index 1) priority fee rewards from the last 10 blocks
          const rewards: Array<Array<BigIntInput | null | undefined>> = feeHistory?.reward ?? [];
          const p50s = rewards.map((r) => (r && r[1] != null ? BigInt(r[1]) : null)).filter((r): r is bigint => r !== null && r > 0n);

          if (p50s.length > 0) {
            const sorted = [...p50s].sort((a, b) => (a > b ? 1 : a < b ? -1 : 0));
            const medianPriority = sorted[Math.floor(sorted.length / 2)];
            // Clamp: never below 25 gwei (Polygon minimum for prompt inclusion),
            // never above 500 gwei (avoids outliers)
            const floor = 25n * 10n ** 9n;
            const ceil = 500n * 10n ** 9n;
            this.priorityFee = medianPriority < floor ? floor : medianPriority > ceil ? ceil : medianPriority;
            gasPriceGwei.set(Number(this.priorityFee) / 1e9);
          }
          // If no valid rewards returned, keep the previous priorityFee
        } catch {
          // eth_feeHistory not supported on this endpoint (e.g. some public RPCs).
          // Retain existing priorityFee (already conservative at 30 gwei default).
        }

        this.maxFee = this.baseFee * 2n + this.priorityFee;
        this.updatedAt = Date.now();
      } catch (err: unknown) {
        const message = (err as { message?: unknown } | null | undefined)?.message ?? err;
        console.warn(`[gas_oracle] Update failed: ${String(message)}`);
      }
    })();

    try {
      await this._updatePromise;
    } finally {
      this._updatePromise = null;
    }
  }

  getTokenPrice(tokenAddress: string) {
    return this.tokenPrices.get(tokenAddress.toLowerCase()) || null;
  }

  /**
   * Get the latest cached fee data.
   */
  getFees() {
    const snapshot = {
      baseFee: this.baseFee,
      priorityFee: this.priorityFee,
      maxFee: this.maxFee,
      updatedAt: this.updatedAt,
    };
    return {
      ...snapshot,
      effectiveGasPriceWei: effectiveGasPriceWei(snapshot),
    };
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }
}

export const oracle = new GasOracle();
// Start oracle automatically in production-like environments
if (process.env.NODE_ENV !== "test") {
  oracle.start();
}

// ─── Gas price ────────────────────────────────────────────────

export async function fetchGasPrice() {
  // Fix #3: use dedicated gasOracleClient rather than shared rotation pool.
  return gasOracleClient.getGasPrice();
}

/**
 * Fetch EIP-1559 fee data: baseFeePerGas + maxPriorityFeePerGas.
 * Uses the background oracle for zero-latency access.
 */
export async function fetchEIP1559Fees() {
  return ensureFreshGasOracle();
}

// ─── Gas estimation ───────────────────────────────────────────

export async function estimateGas(tx: GasTxRequest, fromAddress: string) {
  // Fix #3: use dedicated GAS_ESTIMATION_RPC_URL client for eth_estimateGas.
  // This keeps simulation traffic off the shared pool and uses a potentially
  // simulation-quality endpoint (e.g. Tenderly, Alchemy Simulation API).
  const { estimateGas: estimateGasFromModule } = await import("./gas_estimator.ts");
  return estimateGasFromModule({
    to: tx.to as `0x${string}`,
    data: tx.data as `0x${string}`,
    from: fromAddress as `0x${string}`,
    value: tx.value ?? 0n,
  });
}

export function clearGasEstimateCache() {
  gasEstimateCache.clear();
}

export function gasEstimateCacheStats() {
  return {
    size: gasEstimateCache.size,
    keys: [...gasEstimateCache.keys()],
  };
}

export function isGasOracleStale(updatedAt: number, options: GasOracleFreshnessOptions = {}) {
  const now = Number(options.now ?? Date.now());
  const maxAgeMs = Number(options.maxAgeMs ?? GAS_ORACLE_MAX_AGE_MS);
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return true;
  if (!Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) return true;
  const ageMs = now - updatedAt;
  return ageMs > maxAgeMs || ageMs < -maxAgeMs;
}

export async function ensureFreshGasOracle(options: GasOracleFreshnessOptions = {}) {
  const { maxAgeMs = GAS_ORACLE_MAX_AGE_MS, allowStaleOnFailure = true } = options;

  const before = oracle.getFees();
  if (!isGasOracleStale(before.updatedAt, { maxAgeMs })) {
    return before;
  }

  await oracle.update();

  const after = oracle.getFees();
  if (!isGasOracleStale(after.updatedAt, { maxAgeMs })) {
    return after;
  }

  if (allowStaleOnFailure && after.updatedAt > 0) {
    return after;
  }

  throw new Error("Gas oracle has no fresh fee snapshot available.");
}

export function gasEstimateCacheKey(tx: GasTxRequest | null | undefined, fromAddress: string | null | undefined) {
  const to = String(tx?.to ?? "").toLowerCase();
  const data = String(tx?.data ?? "").toLowerCase();
  const value = String(tx?.value ?? 0n);
  const account = String(fromAddress ?? "").toLowerCase();
  return `${account}|${to}|${value}|${data}`;
}

function clampBigInt(value: bigint, min: bigint, max: bigint) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Scale the priority fee bid up with expected profit margin.
 *
 * Margin is expressed in basis points of the input amount. The bid ramps from
 * 1.0x at 0 bps to 3.0x once the margin reaches 500 bps (5%).
 */
export function scalePriorityFeeByProfitMargin(
  fees: { baseFee: bigint; priorityFee: bigint; maxFee: bigint },
  profitMarginBps: bigint | number,
  options: PriorityFeeScalingOptions = {},
) {
  const normalizedFees = normalizeFeeSnapshot(fees);
  const minMultiplierBps = BigInt(options.minMultiplierBps ?? 10_000n);
  const maxMultiplierBps = BigInt(options.maxMultiplierBps ?? 30_000n);
  const fullRampMarginBps = BigInt(options.fullRampMarginBps ?? 500n);
  if (minMultiplierBps < 0n || maxMultiplierBps < 0n) {
    throw new Error("priority fee multipliers must be >= 0");
  }
  if (maxMultiplierBps < minMultiplierBps) {
    throw new Error("maxMultiplierBps must be >= minMultiplierBps");
  }
  if (fullRampMarginBps <= 0n) {
    throw new Error("fullRampMarginBps must be > 0");
  }

  const margin = clampBigInt(BigInt(profitMarginBps ?? 0), 0n, fullRampMarginBps);
  const multiplierBps = minMultiplierBps + ((maxMultiplierBps - minMultiplierBps) * margin) / fullRampMarginBps;
  const maxPriorityFeePerGas = (normalizedFees.priorityFee * multiplierBps + 9_999n) / 10_000n;
  const maxFeePerGas = normalizedFees.baseFee * 2n + maxPriorityFeePerGas;

  return {
    multiplierBps,
    maxPriorityFeePerGas,
    maxFeePerGas,
  };
}

// ─── Recommended gas params ────────────────────────────────────

/**
 * Compute recommended gas parameters for a transaction.
 * Uses cached fees from the oracle to minimize hot-path latency.
 */
export async function recommendGasParams(
  tx: GasTxRequest,
  fromAddress: string,
  options: RecommendGasParamsOptions = {},
): Promise<RecommendedGasParams> {
  const {
    gasMultiplier = 1.25,
    maxFeeOverride,
    priorityFeeOverride,
    gasEstimateCacheKey,
    forceRefreshEstimate = false,
    requireFreshFees = true,
    gasOracleMaxAgeMs = GAS_ORACLE_MAX_AGE_MS,
    allowStaleFeesOnRefreshFailure = true,
    maxEstimatedCostWei,
    gasEstimateCacheTtlMs = GAS_ESTIMATE_CACHE_TTL_MS,
    gasEstimateCacheMaxEntries = GAS_ESTIMATE_CACHE_MAX_ENTRIES,
    now = Date.now(),
    estimateGasFn = estimateGas,
    feeSnapshot = null,
  } = options;
  const nowMs = normalizeNowMs(now);
  const cacheTtlMs = normalizeCacheTtlMs(gasEstimateCacheTtlMs);
  const cacheMaxEntries = normalizeCacheMaxEntries(gasEstimateCacheMaxEntries);

  // Only perform eth_estimateGas on the hot path when the route shape is not
  // already cached for the current topology version.
  let gasEstimate: bigint | undefined = undefined;
  if (gasEstimateCacheKey && !forceRefreshEstimate) {
    gasEstimate = getCachedGasEstimate(gasEstimateCacheKey, nowMs, cacheTtlMs) ?? undefined;
  }
  if (gasEstimate == null) {
    const raw = await estimateGasFn(tx, fromAddress);
    gasEstimate = normalizeGasEstimate(raw) ?? undefined;
    if (gasEstimate == null) {
      gasEstimate = 500_000n;
    }
    if (gasEstimateCacheKey) {
      rememberGasEstimate(gasEstimateCacheKey, gasEstimate, nowMs, cacheMaxEntries);
    }
  }
  const fees = normalizeFeeSnapshot(
    feeSnapshot ??
      (requireFreshFees
        ? await ensureFreshGasOracle({
            maxAgeMs: gasOracleMaxAgeMs,
            allowStaleOnFailure: allowStaleFeesOnRefreshFailure,
          })
        : oracle.getFees()),
  );

  const baseFee = fees.baseFee;
  let maxPriorityFeePerGas = priorityFeeOverride ?? fees.priorityFee;
  let maxFeePerGas = maxFeeOverride ?? fees.maxFee;

  if (maxFeeOverride != null && maxFeePerGas < baseFee) {
    throw new Error("maxFeePerGas is below current baseFee");
  }
  if (priorityFeeOverride != null && maxFeeOverride == null) {
    maxFeePerGas = maxBigInt(maxFeePerGas, baseFee * 2n + maxPriorityFeePerGas);
  }
  const gasLimit = bufferedGasLimit(gasEstimate, gasMultiplier);
  ({ maxFeePerGas, maxPriorityFeePerGas } = capGasFeesToBudget(
    { baseFee, maxFeePerGas, maxPriorityFeePerGas },
    gasLimit,
    maxEstimatedCostWei,
  ));

  if (maxPriorityFeePerGas > maxFeePerGas) {
    if (priorityFeeOverride != null && maxFeeOverride != null && maxEstimatedCostWei == null) {
      throw new Error("maxPriorityFeePerGas cannot exceed maxFeePerGas");
    }
    maxPriorityFeePerGas = maxFeePerGas;
  }

  const effectiveGasPrice = effectiveGasPriceWei({
    baseFee,
    priorityFee: maxPriorityFeePerGas,
    maxFee: maxFeePerGas,
  });
  const estimatedCostWei = gasLimit * effectiveGasPrice;
  const maxCostWei = gasLimit * maxFeePerGas;

  return {
    maxFeePerGas,
    maxPriorityFeePerGas,
    gasLimit,
    effectiveGasPriceWei: effectiveGasPrice,
    estimatedCostWei,
    maxCostWei,
  };
}

export async function quickGasCheck(estimatedGasUnits = 400_000) {
  if (!Number.isSafeInteger(estimatedGasUnits) || estimatedGasUnits <= 0) {
    throw new Error("estimatedGasUnits must be a positive safe integer");
  }
  const fees = await ensureFreshGasOracle();
  const gasPrice = effectiveGasPriceWei(fees);
  const estimatedCostWei = gasPrice * BigInt(estimatedGasUnits);
  return { gasPrice, estimatedCostWei, maxCostWei: fees.maxFee * BigInt(estimatedGasUnits) };
}
