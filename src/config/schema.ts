import * as z from "zod";

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
  stateRpcUrl: z.string().optional(),
  executionRpcUrl: z.string().min(1, "EXECUTION_RPC is required"),
  requestTimeoutMs: numberFromString.int().positive(),
  batchWaitMs: numberFromString.int().nonnegative(),
  batchSize: numberFromString.int().positive(),
  // Paid RPC Tier Settings
  chainstackRps: numberFromString.int().positive().optional(),
  alchemyApiKey: z.string().optional(),
  alchemyBatchRequests: z.coerce.boolean().default(true),
  // HyperRPC (high-performance provider for the listed read methods)
  hyperRpcUrl: z.string().optional(),
  hyperRpcApiToken: z.string().optional(),
  hyperSyncUrl: z.string().optional(),
  // Client-side pacing for direct @envio-dev/hypersync-client usage (and passed to HyperSyncService).
  hypersyncMaxRpmPerToken: numberFromString.int().positive().optional(),
});
export type RpcConfig = z.infer<typeof RpcConfigSchema>;

export const GasConfigSchema = z.object({
  pollIntervalMs: numberFromString.int().positive(),
  priorityFeeFloorGwei: numberFromString.positive(),
  priorityFeeCeilingGwei: numberFromString.positive(),
  maxBidMultiplier: numberFromString.positive(),
  eip1559Enabled: z.coerce.boolean().default(true),
  feeHistoryPercentile: numberFromString.int().min(0).max(100).default(50),
  emaAlpha: numberFromString.min(0).max(1).default(0.3),
  baseFeeBufferMultiplier: numberFromString.min(1).max(5).default(1.1),
  maxPriorityFeePercentile: numberFromString.int().min(0).max(100).default(75),
  historySize: numberFromString.int().positive().default(20),
  spikePriorityFeeMultiplier: numberFromString.min(1).max(5).default(1.6),
});
export type GasConfig = z.infer<typeof GasConfigSchema>;

export const RoutingConfigSchema = z.object({
  maxHops: numberFromString.int().min(2).max(8),
  cycleRefreshIntervalMs: numberFromString.int().positive(),
  liquidityFloorUsd: numberFromString.nonnegative(),
  enumerationMaxPaths: numberFromString.int().positive(),
  concurrency: numberFromString.int().positive().default(75),
  ternarySearchIterations: numberFromString.int().min(5).max(50).default(12),
  maxPriceImpactThreshold: numberFromString.min(0.01).max(0.5).default(0.1),
  v3ShallowMaxImpactBps: numberFromString.int().min(1).max(500).default(30),
  tickFetchEnabled: z.coerce.boolean().default(true),
  tickWordRange: numberFromString.int().min(1).max(20).default(3),
  tickRefreshOnMove: z.coerce.boolean().default(true),
  graphFullRebuildInterval: numberFromString.int().positive().default(100),
  cycleFinder: z.enum(["dfs", "bellman-ford"]).default("dfs"),
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
  receiptTimeoutMs: numberFromString.int().positive(),
  receiptPollMs: numberFromString.int().positive().default(500),
  quarantineBaseMs: numberFromString.int().positive().default(2000),
  quarantineMaxMs: numberFromString.int().positive().default(600_000),
  executorAddress: z.string().min(1, "EXECUTOR_ADDRESS is required"),
  privateKey: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "PRIVATE_KEY must be 0x + 64 hex chars"),
  chainId: numberFromString.int().positive().default(137),
  roiSafetyCap: numberFromString.min(1.0).max(100.0).default(10.0),
  minLiquidityV3Rate: bigintFromString.default(100000000000000000n),
});
export type ExecutionConfig = z.infer<typeof ExecutionConfigSchema>;

export const SyncConfigSchema = z.object({
  headDrivenRefresh: z.coerce.boolean().default(true),
  headRefreshMaxPools: numberFromString.int().positive().default(50),
});
export type SyncConfig = z.infer<typeof SyncConfigSchema>;

export const OracleConfigSchema = z.object({
  enabled: z.coerce.boolean().default(true),
  pythHermesUrl: z.string().url().default("https://hermes.pyth.network"),
  maxDivergenceBps: numberFromString.int().min(50).max(5000).default(500),
});
export type OracleConfig = z.infer<typeof OracleConfigSchema>;

export const MevConfigSchema = z.object({
  enabled: z.coerce.boolean().default(false),
  fastlaneRelayUrl: z.string().default("https://polygon-rpc.fastlane.xyz"),
  publicBackrunFallback: z.coerce.boolean().default(true),
  jitEnabled: z.coerce.boolean().default(false),
  sandwichEnabled: z.coerce.boolean().default(false),
  maxBidBps: numberFromString.int().min(1).max(10_000).default(500),
  /** How long to wait for a submitted FastLane bundle to land before public fallback. */
  bundleWaitMs: numberFromString.int().min(500).max(30_000).default(6000),
});
export type MevConfig = z.infer<typeof MevConfigSchema>;

export const RankingConfigSchema = z.object({
  mode: z.enum(["statistical", "ml", "off"]).default("statistical"),
  modelPath: z.string().default("data/ranking-model.json"),
});
export type RankingConfig = z.infer<typeof RankingConfigSchema>;

export const MempoolConfigSchema = z.object({
  enabled: z.coerce.boolean(),
  websocketUrl: z.string().default(""),
  coalesceTtlMs: numberFromString.int().nonnegative(),
  largeSwapThresholdUsd: numberFromString.positive(),
});
export type MempoolConfig = z.infer<typeof MempoolConfigSchema>;

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
  sync: SyncConfigSchema,
  oracle: OracleConfigSchema,
  mev: MevConfigSchema,
  ranking: RankingConfigSchema,
  execution: ExecutionConfigSchema,
  mempool: MempoolConfigSchema,
  observability: ObservabilityConfigSchema,
  paths: PathsConfigSchema,
  envioApiToken: z.string().default(""),
  hasuraUrl: z.string().url().default("http://localhost:8080/v1/graphql"),
  hasuraSecret: z.string().default("testing"),
  discoveryIntervalMs: numberFromString.int().positive().default(60000),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;
