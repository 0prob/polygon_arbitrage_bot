import * as zod from "zod";
import { AppConfigSchema, type AppConfig } from "./schema.ts";
import { DEFAULTS } from "./defaults.ts";

/** Map env var name -> nested config path. Used to translate flat env vars to nested config. */
const ENV_TO_PATH: Record<string, [keyof AppConfig, string]> = {
  POLYGON_RPC_URLS: ["rpc", "polygonRpcUrls"],
  POLYGON_RPC_URL: ["rpc", "polygonRpcUrls"], // alias
  POLYGON_RPC: ["rpc", "polygonRpcUrls"], // alias
  EXECUTION_RPC: ["rpc", "executionRpcUrl"],
  CONFIG_JSON_RPC_TIMEOUT_MS: ["rpc", "requestTimeoutMs"],
  RPC_BATCH_WAIT_MS: ["rpc", "batchWaitMs"],
  RPC_BATCH_SIZE: ["rpc", "batchSize"],
  HYPERRPC_URL: ["rpc", "hyperRpcUrl"],
  HYPERRPC_API_TOKEN: ["rpc", "hyperRpcApiToken"],
  HYPER_SYNC_URL: ["rpc", "hyperSyncUrl"],

  GAS_POLL_INTERVAL_MS: ["gas", "pollIntervalMs"],
  POLYGON_PRIORITY_FEE_FLOOR_GWEI: ["gas", "priorityFeeFloorGwei"],
  POLYGON_PRIORITY_FEE_CEILING_GWEI: ["gas", "priorityFeeCeilingGwei"],
  POLYGON_MAX_BID_MULTIPLIER: ["gas", "maxBidMultiplier"],
  EIP1559_ENABLED: ["gas", "eip1559Enabled"],
  GAS_FEE_HISTORY_PERCENTILE: ["gas", "feeHistoryPercentile"],
  GAS_EMA_ALPHA: ["gas", "emaAlpha"],
  GAS_BASE_FEE_BUFFER_MULTIPLIER: ["gas", "baseFeeBufferMultiplier"],
  GAS_MAX_PRIORITY_FEE_PERCENTILE: ["gas", "maxPriorityFeePercentile"],
  GAS_HISTORY_SIZE: ["gas", "historySize"],
  GAS_SPIKE_PRIORITY_FEE_MULTIPLIER: ["gas", "spikePriorityFeeMultiplier"],

  ROUTING_MAX_HOPS: ["routing", "maxHops"],
  CYCLE_REFRESH_INTERVAL_MS: ["routing", "cycleRefreshIntervalMs"],
  LIQUIDITY_FLOOR_USD: ["routing", "liquidityFloorUsd"],
  ROUTING_ENUMERATION_MAX_PATHS: ["routing", "enumerationMaxPaths"],
  ROUTING_CONCURRENCY: ["routing", "concurrency"],
  TERNARY_SEARCH_ITERATIONS: ["routing", "ternarySearchIterations"],
  MAX_PRICE_IMPACT_THRESHOLD: ["routing", "maxPriceImpactThreshold"],
  GRAPH_FULL_REBUILD_INTERVAL: ["routing", "graphFullRebuildInterval"],

  MIN_PROFIT_WEI: ["execution", "minProfitWei"],
  SLIPPAGE_BPS: ["execution", "slippageBps"],
  REVERT_RISK_BPS: ["execution", "revertRiskBps"],
  FLASH_LOAN_FEE_BPS: ["execution", "flashLoanFeeBpsBalancer"],
  FLASH_LOAN_FEE_BPS_AAVE: ["execution", "flashLoanFeeBpsAaveV3"],
  FLASH_LOAN_SOURCE: ["execution", "flashLoanSource"],
  PRIVATE_RELAY_URLS: ["execution", "privateRelayUrls"],
  SUBMISSION_STRATEGY: ["execution", "submissionStrategy"],
  RECEIPT_TIMEOUT_MS: ["execution", "receiptTimeoutMs"],
  QUARANTINE_BASE_MS: ["execution", "quarantineBaseMs"],
  QUARANTINE_MAX_MS: ["execution", "quarantineMaxMs"],
  EXECUTOR_ADDRESS: ["execution", "executorAddress"],
  PRIVATE_KEY: ["execution", "privateKey"],
  CHAIN_ID: ["execution", "chainId"],
  ROI_SAFETY_CAP: ["execution", "roiSafetyCap"],
  MIN_LIQUIDITY_V3_RATE: ["execution", "minLiquidityV3Rate"],

  MEMPOOL_ENABLED: ["mempool", "enabled"],
  MEMPOOL_WEBSOCKET_URL: ["mempool", "websocketUrl"],
  MEMPOOL_COALESCE_TTL_MS: ["mempool", "coalesceTtlMs"],
  MEMPOOL_LARGE_SWAP_THRESHOLD_USD: ["mempool", "largeSwapThresholdUsd"],

  DATA_DIR: ["paths", "dataDir"],
  PERF_JSON_FILE: ["paths", "perfJsonFile"],

  FASTLANE_ENABLED: ["fastlane", "enabled"],
  FASTLANE_RPC_URL: ["fastlane", "rpcUrl"],
  FASTLANE_BLOCK_WINDOW: ["fastlane", "blockNumberWindow"],
  FASTLANE_TIMESTAMP_WINDOW_S: ["fastlane", "timestampWindowS"],

  HYPERSYNC_MAX_RPM_PER_TOKEN: ["rpc", "hypersyncMaxRpmPerToken"],
  CHAINSTACK_RPS: ["rpc", "chainstackRps"],
  ALCHEMY_API_KEY: ["rpc", "alchemyApiKey"],
  ALCHEMY_BATCH_REQUESTS: ["rpc", "alchemyBatchRequests"],

  LOG_LEVEL: ["observability", "logLevel"],
  TUI: ["observability", "tuiEnabled"],

  ENVIO_API_TOKEN: ["envioApiToken" as keyof AppConfig, ""],
  HASURA_URL: ["hasuraUrl" as keyof AppConfig, ""],
  HASURA_SECRET: ["hasuraSecret" as keyof AppConfig, ""],
};

/** Deep merge defaults with overrides. Override wins where present. */
function deepMerge<T>(base: T, override: Partial<T>): T {
  if (Array.isArray(base)) return (override ?? base) as T;
  if (typeof base !== "object" || base === null) return (override ?? base) as T;
  const out = { ...(base as object) } as Record<string, unknown>;
  for (const [k, v] of Object.entries(override ?? {})) {
    if (v === undefined) continue;
    const current = (base as Record<string, unknown>)[k];
    if (typeof current === "object" && current !== null && !Array.isArray(current)) {
      out[k] = deepMerge(current, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

/** Build raw config object from env vars by mapping each known env var to its nested path */
function envToOverrides(env: NodeJS.ProcessEnv): Record<string, Record<string, unknown>> {
  const overrides: Record<string, Record<string, unknown>> = {};
  for (const [envKey, mapping] of Object.entries(ENV_TO_PATH)) {
    let value = env[envKey];
    if (value == null || value === "") continue;

    // Deduplicate if it looks like a doubled/quadrupled address or key
    if (typeof value === "string" && value.startsWith("0x")) {
      const parts = value.split("0x").filter((p) => p.length > 0);
      if (parts.length > 1 && parts.every((p) => p === parts[0])) {
        value = "0x" + parts[0];
      }
    }

    const [section, field] = mapping;
    if (
      section === ("envioApiToken" as keyof AppConfig) ||
      section === ("hasuraUrl" as keyof AppConfig) ||
      section === ("hasuraSecret" as keyof AppConfig)
    ) {
      (overrides as Record<string, unknown>)[section as string] = value;
      continue;
    }
    const sectionStr = section as string;
    if (!overrides[sectionStr]) overrides[sectionStr] = {};
    overrides[sectionStr][field] = value;
  }
  return overrides;
}

/** Load and validate configuration */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const overrides = envToOverrides(env);
  const merged = deepMerge(DEFAULTS as unknown as AppConfig, overrides as unknown as Partial<AppConfig>);
  try {
    return AppConfigSchema.parse(merged);
  } catch (err) {
    if (err instanceof zod.ZodError) {
      const issues = err.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
      throw new Error(`Configuration validation failed:\n${issues}`);
    }
    throw err;
  }
}

/** Load config or throw a friendly error and exit */
export function loadConfigOrDie(env: NodeJS.ProcessEnv = process.env): AppConfig {
  try {
    return loadConfig(env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\n${message}\n\n`);
    process.exit(1);
  }
}
