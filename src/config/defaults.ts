import os from "os";

/** Default values for all configuration. These are the values used when no env var or override is provided. */
export const DEFAULTS = {
  rpc: {
    polygonRpcUrls: [
      "https://polygon-rpc.com",
      "https://polygon-mainnet.public.blastapi.io",
      "https://1rpc.io/matic",
      "https://rpc.ankr.com/polygon",
    ],
    executionRpcUrl: "" as string, // required, no default
    gasEstimationRpcUrl: "" as string, // required, no default
    requestTimeoutMs: 8_000,
    batchWaitMs: 16,
    batchSize: 100,
  },
  gas: {
    pollIntervalMs: 2_000,
    bufferBps: 105,
    multiplier: 110,
    priorityFeeFloorGwei: 30,
    priorityFeeCeilingGwei: 500,
    maxBidMultiplier: 5,
    cacheTtlMs: 120_000,
    cacheSize: 2_048,
    defaultGasBufferBps: 105,
    eip1559Enabled: true,
    feeHistoryPercentile: 50,
    emaAlpha: 0.3,
    baseFeeBufferMultiplier: 1.1,
    maxPriorityFeePercentile: 75,
    historySize: 20,
  },
  routing: {
    maxHops: 4,
    maxTotalPaths: 50_000,
    maxPathsToOptimize: 40,
    cycleRefreshIntervalMs: 1_000,
    liquidityFloorUsd: 50,
    workerCount: Math.max(1, os.cpus().length - 1),
    evalWorkerThreshold: 20,
    enumerationMaxPaths: 5_000,
    enumerationMax4HopPaths: 2_000,
  },
  execution: {
    minProfitWei: 100_000_000_000_000_000n, // 0.1 MATIC (~$0.10)
    slippageBps: 50n, // 0.5%
    revertRiskBps: 500n, // 5% base
    flashLoanFeeBpsBalancer: 0n,
    flashLoanFeeBpsAaveV3: 5n,
    flashLoanSource: "BALANCER" as const,
    privateRelayUrls: [] as string[],
    submissionStrategy: "hybrid" as const,
    dryRunBeforeSubmit: true,
    receiptTimeoutMs: 30_000,
    maxConcurrentExecutions: 1,
  },
  discovery: {
    refreshIntervalMs: 300_000,
    concurrency: 4,
  },
  watcher: {
    idleSleepMs: 1_000,
    enrichmentBackfillLookbackBlocks: 1_000,
    enrichmentMaxPools: 500,
  },
  predictiveCache: {
    enabled: false,
    maxPaths: 500,
    precomputeCount: 50,
    refreshIntervalMs: 100,
  },
  mempool: {
    enabled: true,
    websocketUrl: "" as string, // optional
    coalesceTtlMs: 100,
    largeSwapThresholdUsd: 10_000,
  },
  fastlane: {
    enabled: false,
    rpcUrl: "https://polygon-rpc.fastlane.xyz",
    blockNumberWindow: 50,
    timestampWindowS: 60,
  },
  observability: {
    logLevel: "info" as const,
    tuiEnabled: false,
  },
  paths: {
    dataDir: "data",
    perfJsonFile: "perf.json",
  },
} as const;
