import { describe, it, expect } from "vitest";
import { bootApplication } from "./boot";
import type { AppConfig } from "../config/schema";

describe("bootApplication", () => {
  it("should instantiate multiple submitters if multiple private relays are provided", async () => {
    const config = {
      rpc: {
        polygonRpcUrls: ["http://localhost:8545"],
        executionRpcUrl: "http://localhost:8545",
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
        receiptTimeoutMs: 1000,
        chainId: 137,
      },
      gas: {
        pollIntervalMs: 1000,
        priorityFeeFloorGwei: 1,
        priorityFeeCeilingGwei: 1,
        maxBidMultiplier: 1,
        eip1559Enabled: false,
        feeHistoryPercentile: 50,
        emaAlpha: 0.3,
        baseFeeBufferMultiplier: 1.0,
        maxPriorityFeePercentile: 75,
        historySize: 10,
      },
      routing: {
        maxHops: 2,
        cycleRefreshIntervalMs: 1000,
        liquidityFloorUsd: 0,
        enumerationMaxPaths: 1,
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

    expect(context.executionService).toBeDefined();
    expect(context.executionService.isQuarantined("test")).toBe(false);
  });
});
