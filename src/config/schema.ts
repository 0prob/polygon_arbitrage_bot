import * as z from "zod";
import { crossChainArbSchema } from "./crosschain_schema.ts";

/** Coerce a string env var to bigint */
const bigintFromString = z.union([
  z.bigint(),
  z
    .string()
    .regex(/^\d+$/)
    .transform((s) => BigInt(s)),
]);

/** Coerce a string env var to number */
const numberFromString = z.coerce.number().finite();

/** Coerce a comma-separated string to array */
const stringArrayFromCsv = z
  .union([
    z.array(z.string()),
    z.string().transform((s) =>
      s
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p.length > 0),
    ),
  ])
  .default([]);

export const RpcConfigSchema = z.object({
  polygonRpcUrls: stringArrayFromCsv,
  executionRpcUrl: z.string().min(1, "EXECUTION_RPC is required"),
  gasEstimationRpcUrl: z.string().min(1, "GAS_ESTIMATION_RPC is required"),
  requestTimeoutMs: numberFromString.int().positive(),
  batchWaitMs: numberFromString.int().nonnegative(),
  batchSize: numberFromString.int().positive(),
});
export type RpcConfig = z.infer<typeof RpcConfigSchema>;

export const GasConfigSchema = z.object({
  pollIntervalMs: numberFromString.int().positive(),
  bufferBps: numberFromString.int().nonnegative(),
  multiplier: numberFromString.int().positive(),
  priorityFeeFloorGwei: numberFromString.positive(),
  priorityFeeCeilingGwei: numberFromString.positive(),
  maxBidMultiplier: numberFromString.positive(),
  cacheTtlMs: numberFromString.int().nonnegative(),
  cacheSize: numberFromString.int().positive(),
  defaultGasBufferBps: numberFromString.int().nonnegative(),
  eip1559Enabled: z.coerce.boolean().default(true),
  feeHistoryPercentile: numberFromString.int().min(0).max(100).default(50),
  emaAlpha: numberFromString.min(0).max(1).default(0.3),
  baseFeeBufferMultiplier: numberFromString.min(1).max(5).default(1.1),
  maxPriorityFeePercentile: numberFromString.int().min(0).max(100).default(75),
  historySize: numberFromString.int().positive().default(20),
});
export type GasConfig = z.infer<typeof GasConfigSchema>;

export const RoutingConfigSchema = z.object({
  maxHops: numberFromString.int().min(2).max(8),
  maxTotalPaths: numberFromString.int().positive(),
  maxPathsToOptimize: numberFromString.int().positive(),
  cycleRefreshIntervalMs: numberFromString.int().positive(),
  liquidityFloorUsd: numberFromString.nonnegative(),
  workerCount: numberFromString.int().positive(),
  evalWorkerThreshold: numberFromString.int().positive(),
  enumerationMaxPaths: numberFromString.int().positive(),
  enumerationMax4HopPaths: numberFromString.int().positive(),
  concurrency: numberFromString.int().positive().default(50),
  ternarySearchIterations: numberFromString.int().min(5).max(50).default(15),
  maxPriceImpactThreshold: numberFromString.min(0.01).max(0.5).default(0.15),
  graphFullRebuildInterval: numberFromString.int().positive().default(100),
});
export type RoutingConfig = z.infer<typeof RoutingConfigSchema>;

export const SubmissionStrategySchema = z.enum(["public", "private", "hybrid"]);
export type SubmissionStrategy = z.infer<typeof SubmissionStrategySchema>;

export const ExecutionConfigSchema = z.object({
  minProfitWei: bigintFromString,
  slippageBps: bigintFromString,
  revertRiskBps: bigintFromString,
  flashLoanFeeBpsBalancer: bigintFromString,
  flashLoanFeeBpsAaveV3: bigintFromString,
  flashLoanSource: z.enum(["BALANCER", "AAVE_V3"]).default("BALANCER"),
  privateRelayUrls: stringArrayFromCsv,
  submissionStrategy: SubmissionStrategySchema,
  dryRunBeforeSubmit: z.preprocess((v) => v === "true" || v === "1" || v === true, z.coerce.boolean()),
  receiptTimeoutMs: numberFromString.int().positive(),
  receiptPollMs: numberFromString.int().positive().default(500),
  maxConcurrentExecutions: numberFromString.int().positive(),
  quarantineBaseMs: numberFromString.int().positive().default(2000),
  quarantineMaxMs: numberFromString.int().positive().default(600_000),
  executorAddress: z.string().min(1, "EXECUTOR_ADDRESS is required"),
  privateKey: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "PRIVATE_KEY must be 0x + 64 hex chars"),
  chainId: numberFromString.int().positive().default(137),
  roiSafetyCap: numberFromString.min(1.0).max(100.0).default(10.0),
  minLiquidityV3Rate: bigintFromString.default(10000000000000000000n),
});
export type ExecutionConfig = z.infer<typeof ExecutionConfigSchema>;

export const DiscoveryConfigSchema = z.object({
  refreshIntervalMs: numberFromString.int().positive(),
  concurrency: numberFromString.int().positive(),
});
export type DiscoveryConfig = z.infer<typeof DiscoveryConfigSchema>;

export const WatcherConfigSchema = z.object({
  idleSleepMs: numberFromString.int().nonnegative(),
  enrichmentBackfillLookbackBlocks: numberFromString.int().positive(),
  enrichmentMaxPools: numberFromString.int().positive(),
});
export type WatcherConfig = z.infer<typeof WatcherConfigSchema>;

export const PredictiveCacheConfigSchema = z.object({
  enabled: z.coerce.boolean(),
  maxPaths: numberFromString.int().positive(),
  precomputeCount: numberFromString.int().nonnegative(),
  refreshIntervalMs: numberFromString.int().positive(),
});
export type PredictiveCacheConfig = z.infer<typeof PredictiveCacheConfigSchema>;

export const MempoolConfigSchema = z.object({
  enabled: z.coerce.boolean(),
  websocketUrl: z.string().default(""),
  coalesceTtlMs: numberFromString.int().nonnegative(),
  largeSwapThresholdUsd: numberFromString.positive(),
});
export type MempoolConfig = z.infer<typeof MempoolConfigSchema>;

export const FastLaneConfigSchema = z.object({
  enabled: z.coerce.boolean().default(false),
  rpcUrl: z.string().default("https://polygon-rpc.fastlane.xyz"),
  blockNumberWindow: z.coerce.number().int().positive().default(50),
  timestampWindowS: z.coerce.number().int().positive().default(60),
});
export type FastLaneConfig = z.infer<typeof FastLaneConfigSchema>;

export const ObservabilityConfigSchema = z.object({
  logLevel: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]),
  tuiEnabled: z.preprocess((v) => v === "true" || v === "1" || v === true, z.coerce.boolean()),
});
export type ObservabilityConfig = z.infer<typeof ObservabilityConfigSchema>;

export const PathsConfigSchema = z.object({
  dataDir: z.string().min(1),
  perfJsonFile: z.string().min(1),
});
export type PathsConfig = z.infer<typeof PathsConfigSchema>;

export const AppConfigSchema = z.object({
  rpc: RpcConfigSchema,
  gas: GasConfigSchema,
  routing: RoutingConfigSchema,
  execution: ExecutionConfigSchema,
  discovery: DiscoveryConfigSchema,
  watcher: WatcherConfigSchema,
  predictiveCache: PredictiveCacheConfigSchema,
  mempool: MempoolConfigSchema,
  fastlane: FastLaneConfigSchema,
  observability: ObservabilityConfigSchema,
  paths: PathsConfigSchema,
  envioApiToken: z.string().min(1, "ENVIO_API_TOKEN is required"),
  hasuraUrl: z.string().url().default("http://localhost:8080/v1/graphql"),
  hasuraSecret: z.string().default("testing"),
  crossChainArb: crossChainArbSchema.optional(),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;
