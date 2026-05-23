import { BotSystem } from '../src/orchestrator/system';
import type { AppConfig } from '../src/config/schema';

export class BotTestHarness {
  public readonly system: BotSystem;

  constructor(config?: Partial<AppConfig>) {
    const defaultConfig: AppConfig = {
      rpc: {
        polygonRpcUrls: ['https://rpc.example.com'],
        executionRpcUrl: 'https://rpc.example.com',
        gasEstimationRpcUrl: 'https://rpc.example.com',
        hyperRpcUrl: 'https://rpc.example.com',
        requestTimeoutMs: 1000,
        batchWaitMs: 10,
        batchSize: 100,
      },
      hypersync: {
        url: 'https://hypersync.example.com',
        httpReqTimeoutMs: 1000,
        maxRetries: 3,
        retryBaseMs: 100,
        retryCeilingMs: 1000,
        retryBackoffMs: 100,
        batchSize: 100,
        maxBlocksPerRequest: 100,
        maxAddressFilter: 100,
        maxFiltersPerRequest: 10,
        streamConcurrency: 5,
        streamBatchSize: 100,
        proactiveRateLimitSleepMs: 0,
      },
      gas: {
        pollIntervalMs: 1000,
        bufferBps: 100,
        multiplier: 1,
        priorityFeeFloorGwei: 0.1,
        priorityFeeCeilingGwei: 10,
        maxBidMultiplier: 1.1,
        cacheTtlMs: 1000,
        cacheSize: 100,
        defaultGasBufferBps: 100,
      },
      routing: {
        maxHops: 3,
        maxTotalPaths: 100,
        maxPathsToOptimize: 10,
        cycleRefreshIntervalMs: 1000,
        liquidityFloorUsd: 100,
        workerCount: 1,
        evalWorkerThreshold: 1,
        enumerationMaxPaths: 100,
        enumerationMax4HopPaths: 100,
      },
      execution: {
        minProfitWei: 1000n,
        slippageBps: 10n,
        revertRiskBps: 10n,
        flashLoanFeeBpsBalancer: 0n,
        flashLoanFeeBpsAaveV3: 0n,
        privateRelayUrls: ['https://relay.example.com'],
        dryRunBeforeSubmit: true,
        receiptTimeoutMs: 1000,
        maxConcurrentExecutions: 1,
        executorAddress: '0x1234567890123456789012345678901234567890',
        privateKey: '0x0000000000000000000000000000000000000000000000000000000000000000',
        chainId: 137,
      },
      discovery: {
        refreshIntervalMs: 1000,
        concurrency: 1,
      },
      watcher: {
        idleSleepMs: 0,
        enrichmentBackfillLookbackBlocks: 100,
        enrichmentMaxPools: 10,
      },
      predictiveCache: {
        enabled: false,
        maxPaths: 100,
        precomputeCount: 0,
        refreshIntervalMs: 1000,
      },
      mempool: {
        enabled: false,
        websocketUrl: '',
        coalesceTtlMs: 0,
        largeSwapThresholdUsd: 100,
      },
      observability: {
        logLevel: 'info',
        tuiEnabled: false,
      },
      paths: {
        dataDir: '/tmp/data',
        perfJsonFile: '/tmp/perf.json',
      },
      envioApiToken: 'token',
    };

    const finalConfig = { ...defaultConfig, ...config } as AppConfig;
    this.system = new BotSystem(finalConfig);
  }
}
