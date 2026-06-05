/** Default values for all configuration. These are the values used when no env var or override is provided. */
export const DEFAULTS = {
  rpc: {
    polygonRpcUrls: [] as string[],
    stateRpcUrl: "" as string,
    executionRpcUrl: "" as string, // required, no default
    requestTimeoutMs: 8_000,
    batchWaitMs: 16,
    batchSize: 100,
    // HyperRPC - when HYPERRPC_API_TOKEN is set, we prefer it for the 10 listed read methods
    // (eth_chainId, eth_blockNumber, eth_getBlock*, eth_getTransaction*, eth_getLogs, eth_getBlockReceipts)
    hyperRpcUrl: "",
    hyperRpcApiToken: "" as string,
    hyperSyncUrl: "",
    hypersyncMaxRpmPerToken: 200,
    chainstackRps: 250,
    alchemyApiKey: "",
    alchemyBatchRequests: true,
  },
  gas: {
    pollIntervalMs: 2_000,
    priorityFeeFloorGwei: 30,
    priorityFeeCeilingGwei: 500,
    maxBidMultiplier: 5,
    eip1559Enabled: true,
    feeHistoryPercentile: 50,
    emaAlpha: 0.3,
    baseFeeBufferMultiplier: 1.1,
    maxPriorityFeePercentile: 75,
    historySize: 20,
    spikePriorityFeeMultiplier: 1.6,
  },
  routing: {
    maxHops: 5, // 4-hop V3 0.05% cycles have 0.2% fee overhead which is viable for real arb spreads
    cycleRefreshIntervalMs: 1_000,
    liquidityFloorUsd: 100,
    enumerationMaxPaths: 5_000, // Raised for long-tail strategy: findCycles can emit 250k; 1k was too restrictive. On low-infra (see pass_loop lowInfra scaling) this gets halved automatically.
    concurrency: 75,
    ternarySearchIterations: 12, // Slightly fewer iterations, more cycles (pairs with higher enumerationMaxPaths)
    maxPriceImpactThreshold: 0.1,
    graphFullRebuildInterval: 100,
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
    receiptTimeoutMs: 30_000,
    quarantineBaseMs: 2_000,
    quarantineMaxMs: 600_000,
    roiSafetyCap: 10.0,
    minLiquidityV3Rate: 100_000_000_000_000_000n,
  },
  mempool: {
    enabled: true,
    websocketUrl: "" as string, // optional
    coalesceTtlMs: 100,
    largeSwapThresholdUsd: 10_000,
  },
  observability: {
    logLevel: "info" as const,
    tuiEnabled: false,
  },
  paths: {
    dataDir: "data",
    perfJsonFile: "perf.json",
  },
  envioApiToken: "",
  hasuraUrl: "http://localhost:8080/v1/graphql",
  hasuraSecret: "testing",
} as const;
