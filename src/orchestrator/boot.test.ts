import { describe, it, expect } from "vitest";
import { bootApplication } from "./boot";
import type { AppConfig } from "../config/schema";

describe("bootApplication", () => {
  it("should instantiate multiple submitters if multiple private relays are provided", async () => {
    const config = {
      rpc: {
        polygonRpcUrls: ["http://localhost:8545"],
        executionRpcUrl: "http://localhost:8545",
        gasEstimationRpcUrl: "http://localhost:8545",
        requestTimeoutMs: 1000,
        batchWaitMs: 0,
        batchSize: 1,
      },
      execution: {
        privateRelayUrls: ["http://relay1.com", "http://relay2.com"],
        privateKey: "0x" + "1".repeat(64),
        executorAddress: "0x" + "2".repeat(40),
        minProfitWei: 0n,
        slippageBps: 0n,
        revertRiskBps: 0n,
        flashLoanFeeBpsBalancer: 0n,
        flashLoanFeeBpsAaveV3: 0n,
        dryRunBeforeSubmit: false,
        receiptTimeoutMs: 1000,
        maxConcurrentExecutions: 1,
        chainId: 137,
      },
      gas: {
        pollIntervalMs: 1000,
        bufferBps: 0,
        multiplier: 1,
        priorityFeeFloorGwei: 1,
        priorityFeeCeilingGwei: 1,
        maxBidMultiplier: 1,
        cacheTtlMs: 1000,
        cacheSize: 1,
        defaultGasBufferBps: 0,
        eip1559Enabled: false,
        feeHistoryPercentile: 50,
        emaAlpha: 0.3,
        baseFeeBufferMultiplier: 1.0,
        maxPriorityFeePercentile: 75,
        historySize: 10,
      },
      routing: {
        maxHops: 2,
        maxTotalPaths: 1,
        maxPathsToOptimize: 1,
        cycleRefreshIntervalMs: 1000,
        liquidityFloorUsd: 0,
        workerCount: 1,
        evalWorkerThreshold: 1,
        enumerationMaxPaths: 1,
        enumerationMax4HopPaths: 1,
      },
      discovery: {
        refreshIntervalMs: 1000,
        concurrency: 1,
      },
      watcher: {
        idleSleepMs: 0,
        enrichmentBackfillLookbackBlocks: 1,
        enrichmentMaxPools: 1,
      },
      predictiveCache: {
        enabled: false,
        maxPaths: 1,
        precomputeCount: 0,
        refreshIntervalMs: 1000,
      },
      mempool: {
        enabled: false,
        websocketUrl: "",
        coalesceTtlMs: 1000,
        largeSwapThresholdUsd: 1,
      },
      observability: {
        logLevel: "info",
        tuiEnabled: false,
      },
      paths: {
        dataDir: "/tmp",
        perfJsonFile: "/tmp/perf.json",
      },
      fastlane: {
        enabled: false,
        rpcUrl: "https://polygon-rpc.fastlane.xyz",
        blockNumberWindow: 50,
        timestampWindowS: 60,
      },
      envioApiToken: "token",
      hasuraUrl: "http://localhost:8080/v1/graphql",
      hasuraSecret: "testing",
    } as AppConfig;

    const context = await bootApplication(config);
    // @ts-expect-error - Checking private member for test
    expect(context.executionService.submitters).toHaveLength(2);
  });
});
