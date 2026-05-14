/**
 * src/state/poll_balancer.js — Balancer V2 vault balances poller
 *
 * Fetches pool state from the Balancer Vault via getPoolTokens(),
 * and fetches per-pool weights + swap fee from the pool contract.
 *
 * Normalizes into canonical state and writes to the shared cache.
 */

import { readContractWithRetry, throttledMap } from "../state/enrichment/rpc.ts";
import { normalizeBalancerState } from "./normalizer.ts";
import { ENRICH_CONCURRENCY } from "../config/index.ts";
import { parsePoolMetadata, parsePoolTokens } from "./pool_record.ts";
import { metadataWithTokenDecimals } from "./pool_metadata.ts";
import {
  asBatchResult,
  TimedPoller,
  type ProtocolPoolRecord,
  type RouteState,
  type RouteStateCache,
  type StatePollerOptions,
  type TokenDecimalsRegistry,
} from "./poller_base.ts";
import { BALANCER_PROTOCOLS, normalizeProtocolKey } from "../protocols/classification.ts";

const BALANCER_VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";
const BALANCER_READ_TIMEOUT_MS = 20_000;

function metadataString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}

function toUnknownArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === "function") {
    return Array.from(value as Iterable<unknown>);
  }
  return [];
}

function toBigIntValue(value: unknown, fallback = 0n) {
  if (typeof value === "bigint") return value;
  if (value == null) return fallback;
  try {
    return BigInt(value as string | number | boolean);
  } catch {
    return fallback;
  }
}

function toBigIntArray(value: unknown) {
  return toUnknownArray(value).map((entry) => toBigIntValue(entry));
}

function toLowerStringArray(value: unknown) {
  return toUnknownArray(value).map((entry) => String(entry).toLowerCase());
}

function tupleValue(value: unknown, key: string, index: number) {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return record[key] ?? record[String(index)];
}

const GET_POOL_TOKENS_ABI = [
  {
    name: "getPoolTokens",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "tokens", type: "address[]" },
      { name: "balances", type: "uint256[]" },
      { name: "lastChangeBlock", type: "uint256" },
    ],
  },
];

const GET_NORMALIZED_WEIGHTS_ABI = [
  {
    name: "getNormalizedWeights",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256[]" }],
  },
];

const GET_SWAP_FEE_ABI = [
  {
    name: "getSwapFeePercentage",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
];

const GET_AMPLIFICATION_PARAMETER_ABI = [
  {
    name: "getAmplificationParameter",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "value", type: "uint256" },
      { name: "isUpdating", type: "bool" },
      { name: "precision", type: "uint256" },
    ],
  },
];

const GET_SCALING_FACTORS_ABI = [
  {
    name: "getScalingFactors",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256[]" }],
  },
];

const GET_BPT_INDEX_ABI = [
  {
    name: "getBptIndex",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
];

const VERSION_ABI = [
  {
    name: "version",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
];

const GET_POOL_ID_ABI = [
  {
    name: "getPoolId",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
];

function withTimeout<T>(promise: Promise<T>, label: string, ms = BALANCER_READ_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });

  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

async function readContractWithTimeout<T = unknown>(params: Parameters<typeof readContractWithRetry>[0], label: string): Promise<T> {
  return withTimeout(readContractWithRetry(params) as Promise<T>, label, BALANCER_READ_TIMEOUT_MS);
}

function removeArrayIndex<T>(values: T[], index: number | null) {
  if (index == null || !Number.isInteger(index) || index < 0 || index >= values.length) return values;
  return values.filter((_value, valueIndex) => valueIndex !== index);
}

function parsePoolVersion(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed?.name === "string" ? parsed.name : value;
  } catch {
    return value || null;
  }
}

async function fetchBalancerStableState(poolAddress: string, tokens: string[], balances: bigint[]) {
  const [ampResult, scalingResult, bptIndexResult, versionResult, feeResult] = await Promise.allSettled([
    readContractWithTimeout(
      {
        address: poolAddress,
        abi: GET_AMPLIFICATION_PARAMETER_ABI,
        functionName: "getAmplificationParameter",
      },
      `Balancer getAmplificationParameter ${poolAddress}`,
    ),
    readContractWithTimeout(
      {
        address: poolAddress,
        abi: GET_SCALING_FACTORS_ABI,
        functionName: "getScalingFactors",
      },
      `Balancer getScalingFactors ${poolAddress}`,
    ),
    readContractWithTimeout(
      {
        address: poolAddress,
        abi: GET_BPT_INDEX_ABI,
        functionName: "getBptIndex",
      },
      `Balancer getBptIndex ${poolAddress}`,
    ),
    readContractWithTimeout(
      {
        address: poolAddress,
        abi: VERSION_ABI,
        functionName: "version",
      },
      `Balancer version ${poolAddress}`,
    ),
    readContractWithTimeout(
      {
        address: poolAddress,
        abi: GET_SWAP_FEE_ABI,
        functionName: "getSwapFeePercentage",
      },
      `Balancer getSwapFeePercentage ${poolAddress}`,
    ),
  ]);

  if (ampResult.status === "rejected") {
    throw new Error(`getAmplificationParameter failed: unsupported Balancer pool math (${ampResult.reason?.message ?? "unknown error"})`);
  }
  if (scalingResult.status === "rejected") {
    throw new Error(`getScalingFactors failed: unsupported Balancer pool math (${scalingResult.reason?.message ?? "unknown error"})`);
  }

  const ampTuple = ampResult.value;
  const scalingFactors = toBigIntArray(scalingResult.value);
  const rawBptIndex = bptIndexResult.status === "fulfilled" ? Number(bptIndexResult.value) : null;
  const bptIndex = Number.isInteger(rawBptIndex) && rawBptIndex! >= 0 && rawBptIndex! < tokens.length ? rawBptIndex : null;
  const compactTokens = removeArrayIndex(tokens, bptIndex);
  const compactBalances = removeArrayIndex(balances, bptIndex);
  const compactScalingFactors = removeArrayIndex(scalingFactors, bptIndex);
  const version = versionResult.status === "fulfilled" ? parsePoolVersion(versionResult.value) : null;

  return {
    tokens: compactTokens,
    balances: compactBalances,
    scalingFactors: compactScalingFactors.length === compactBalances.length ? compactScalingFactors : compactBalances.map(() => 10n ** 18n),
    amp: toBigIntValue(tupleValue(ampTuple, "value", 0)),
    ampIsUpdating: Boolean(tupleValue(ampTuple, "isUpdating", 1) ?? false),
    ampPrecision: toBigIntValue(tupleValue(ampTuple, "precision", 2), 1000n),
    swapFee:
      feeResult.status === "fulfilled"
        ? toBigIntValue(feeResult.value)
        : (console.warn(`[poll_balancer] Swap fee fetch failed for %s`, poolAddress), 3_000_000_000_000_000n),
    bptIndex,
    poolType: version ?? (bptIndex == null ? "StablePool" : "ComposableStablePool"),
    isStable: true,
  };
}

export async function fetchBalancerPoolState(poolAddress: string, poolId: string | null | undefined) {
  let resolvedPoolId = poolId;
  if (!resolvedPoolId) {
    try {
      resolvedPoolId = await readContractWithTimeout(
        {
          address: poolAddress,
          abi: GET_POOL_ID_ABI,
          functionName: "getPoolId",
        },
        `Balancer getPoolId ${poolAddress}`,
      );
    } catch {
      throw new Error(`Cannot resolve poolId for ${poolAddress}`);
    }
  }

  const [vaultResult, weightsResult, feeResult] = await Promise.allSettled([
    readContractWithTimeout(
      {
        address: BALANCER_VAULT,
        abi: GET_POOL_TOKENS_ABI,
        functionName: "getPoolTokens",
        args: [resolvedPoolId],
      },
      `Balancer getPoolTokens ${poolAddress}`,
    ),
    readContractWithTimeout(
      {
        address: poolAddress,
        abi: GET_NORMALIZED_WEIGHTS_ABI,
        functionName: "getNormalizedWeights",
      },
      `Balancer getNormalizedWeights ${poolAddress}`,
    ),
    readContractWithTimeout(
      {
        address: poolAddress,
        abi: GET_SWAP_FEE_ABI,
        functionName: "getSwapFeePercentage",
      },
      `Balancer getSwapFeePercentage ${poolAddress}`,
    ),
  ]);

  if (vaultResult.status === "rejected") {
    throw new Error(`getPoolTokens failed: ${errorMessage(vaultResult.reason)}`);
  }

  const [vaultTokensRaw, vaultBalancesRaw, lastChangeBlock] = toUnknownArray(vaultResult.value);
  const vaultTokens = toLowerStringArray(vaultTokensRaw);
  const balances = toBigIntArray(vaultBalancesRaw);

  const swapFee = feeResult.status === "fulfilled" ? toBigIntValue(feeResult.value) : 3_000_000_000_000_000n;

  if (weightsResult.status === "rejected") {
    const stableState = await fetchBalancerStableState(poolAddress, vaultTokens, balances);
    return {
      poolId: resolvedPoolId,
      lastChangeBlock: Number(lastChangeBlock),
      fetchedAt: Date.now(),
      ...stableState,
    };
  }

  const weights = toBigIntArray(weightsResult.value);
  if (weights.length !== balances.length) {
    throw new Error(`getNormalizedWeights length mismatch: weights=${weights.length} balances=${balances.length}`);
  }

  return {
    poolId: resolvedPoolId,
    tokens: vaultTokens,
    balances,
    weights,
    swapFee,
    poolType: "WeightedPool",
    isStable: false,
    lastChangeBlock: Number(lastChangeBlock),
    fetchedAt: Date.now(),
  };
}

export async function fetchAndNormalizeBalancerPool(
  pool: ProtocolPoolRecord,
  options: { tokenDecimals?: Map<string, number> | null } = {},
): Promise<{ addr: string; normalized: RouteState }> {
  const addr = pool.pool_address.toLowerCase();
  const meta = parsePoolMetadata(pool.metadata);
  const poolId = metadataString(meta.poolId) ?? metadataString(meta.pool_id);

  const rawState = await fetchBalancerPoolState(addr, poolId);

  const tokens = rawState.tokens.length >= 2 ? rawState.tokens : parsePoolTokens(pool.tokens);
  const metadata = metadataWithTokenDecimals({ ...pool, metadata: meta }, tokens, options.tokenDecimals);

  const normalized = normalizeBalancerState(addr, pool.protocol, tokens, rawState, metadata) as RouteState;

  return { addr, normalized };
}

export class PollBalancer extends TimedPoller {
  private _registry: TokenDecimalsRegistry;
  private _cache: RouteStateCache;
  private _concurrency: number;

  constructor(registry: TokenDecimalsRegistry, stateCache: RouteStateCache, options: StatePollerOptions = {}) {
    super(options);
    this._registry = registry;
    this._cache = stateCache;
    this._concurrency = options.concurrency ?? ENRICH_CONCURRENCY;
  }

  async poll() {
    const t0 = Date.now();

    const pools = this._registry.getActivePoolsMeta().filter((p) => BALANCER_PROTOCOLS.has(normalizeProtocolKey(p.protocol)));

    if (pools.length === 0) {
      return { updated: 0, failed: 0, durationMs: Date.now() - t0 };
    }

    const results = await throttledMap(
      pools,
      async (pool) => {
        try {
          const tokens = parsePoolTokens(pool.tokens);
          const tokenDecimals = this._registry.getTokenDecimals(tokens);
          const { addr, normalized } = await fetchAndNormalizeBalancerPool(pool, { tokenDecimals });
          return asBatchResult<RouteState>(addr, normalized);
        } catch (err) {
          const addr = pool.pool_address.toLowerCase();
          return asBatchResult<RouteState>(addr, null, err);
        }
      },
      this._concurrency,
    );

    const { updated, failed } = this._storeBatchResults("poll_balancer", this._cache, results, ({ addr, normalized }) => {
      return `[poll_balancer] ${addr} balances=${normalized.balances}`;
    });

    return this._completePass("poll_balancer", t0, updated, failed);
  }

  start(intervalMs = 30_000) {
    this._startLoop("poll_balancer", intervalMs, () => this.poll());
  }
}
