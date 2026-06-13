import { describe, it, expect, vi } from "vitest";
import { bootApplication } from "./boot";
import type { AppConfig } from "../config/schema";

vi.mock("viem", async () => {
  const actual = await import("viem");
  return {
    ...actual,
    createPublicClient: vi.fn().mockReturnValue({
      getTransactionCount: vi.fn().mockResolvedValue(0),
      getBytecode: vi.fn().mockResolvedValue("0x1234"),
      getBlock: vi.fn().mockResolvedValue({ number: 1n, hash: "0xabc" }),
      chain: { id: 137 },
      transport: { type: "http" },
    }),
    createWalletClient: vi.fn().mockReturnValue({
      account: { address: "0x123" },
      chain: { id: 137 },
      transport: { type: "http" },
      sendTransaction: vi.fn().mockResolvedValue("0xhash"),
    }),
    http: vi.fn(),
    getAddress: actual.getAddress,
    parseAbi: actual.parseAbi,
    decodeEventLog: actual.decodeEventLog,
    encodeFunctionData: actual.encodeFunctionData,
  };
});

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
        spikePriorityFeeMultiplier: 1.6,
      },
      routing: {
        maxHops: 2,
        cycleRefreshIntervalMs: 1000,
        liquidityFloorUsd: 0,
        enumerationMaxPaths: 1,
      },
      sync: {
        headDrivenRefresh: true,
        headRefreshMaxPools: 50,
      },
      oracle: {
        enabled: false,
        pythHermesUrl: "https://hermes.pyth.network",
        maxDivergenceBps: 500,
      },
      mev: {
        enabled: false,
        fastlaneRelayUrl: "https://polygon-rpc.fastlane.xyz",
        publicBackrunFallback: true,
        jitEnabled: false,
        sandwichEnabled: false,
        maxBidBps: 500,
      },
      ranking: {
        mode: "off" as const,
        modelPath: "data/ranking-model.json",
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
      envioApiToken: "token",
      hasuraUrl: "http://localhost:8080/v1/graphql",
      hasuraSecret: "testing",
    } as AppConfig;

    const context = await bootApplication(config);

    expect(context.executionService).toBeDefined();
    expect(context.executionService.isQuarantined("test")).toBe(false);

    // Graceful shutdown of services to avoid lingering intervals/timers
    context.gasOracle.stop();
    if (context.wsSubscriber) context.wsSubscriber.stop();
    if (context.hyperIndexMonitor) void context.hyperIndexMonitor.stop();
    if (context.mempoolService) void context.mempoolService.stop();
    if (context.executionService) context.executionService.stop();
    if (context.stateRefreshService) void context.stateRefreshService.stop();
  });
});
