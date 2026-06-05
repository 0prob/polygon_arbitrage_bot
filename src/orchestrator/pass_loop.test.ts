import { describe, it, expect, vi } from "vitest";
import { runPassLoop } from "./pass_loop.ts";
import type { PassLoopDeps } from "./loop.ts";
import type { RuntimeContext } from "./boot.ts";
import type { CandidateExecution } from "../services/execution/service.ts";

const MOCK_CANDIDATE_EXECUTION: CandidateExecution = {
  routeKey: "0x1234567890123456789012345678901234567890",
  calldata: "0xdeadbeef",
  targetAddress: "0x0000000000000000000000000000000000000001",
  value: 0n,
};

function mockTracker() {
  return {
    getWinRate: vi.fn().mockReturnValue(0),
    record: vi.fn(),
    getRouteStats: vi.fn(),
    getAllRouteStats: vi.fn().mockReturnValue(new Map()),
    getRecentRecords: vi.fn().mockReturnValue([]),
    summary: { totalAttempts: 0, totalSuccesses: 0, totalReverts: 0, totalProfit: 0n, trackedRoutes: 0 },
  };
}

function mockTierManager() {
  return {
    assess: vi.fn().mockReturnValue("green"),
    getCurrent: vi.fn().mockReturnValue("green"),
    shouldDiscover: vi.fn().mockReturnValue(true),
    shouldExecute: vi.fn().mockReturnValue(true),
    shouldEnumerate: vi.fn().mockReturnValue(true),
    shouldSimulate: vi.fn().mockReturnValue(true),
    shouldPollState: vi.fn().mockReturnValue(true),
    isFull: vi.fn().mockReturnValue(true),
    label: vi.fn().mockReturnValue("[GREEN] healthy"),
  };
}

function mockCircuitBreaker() {
  return {
    execute: vi.fn().mockImplementation(async (fn: Function) => fn()),
    isHealthy: vi.fn().mockReturnValue(true),
    getState: vi.fn().mockReturnValue("closed"),
    getFailureCount: vi.fn().mockReturnValue(0),
    reset: vi.fn(),
  };
}

const VALID_ADDR_A = "0x0000000000000000000000000000000000000001";
const VALID_ADDR_B = "0x0000000000000000000000000000000000000002";
const VALID_ADDR_C = "0x0000000000000000000000000000000000000003";

const stateWithPool = new Map<string, Record<string, unknown>>();
stateWithPool.set("0xpool", { initialized: true });

describe("runPassLoop", () => {
  it("executes profitable cycles", async () => {
    const mockExecute = vi.fn().mockResolvedValue({ success: true, txHash: "0x1" });

    const mockContext = {
      config: {
        routing: {
          cycleRefreshIntervalMs: 0,
          maxHops: 2,
          enumerationMaxPaths: 5000,
          liquidityFloorUsd: 50,
        },
        execution: {
          minProfitWei: 0n,
          executorAddress: VALID_ADDR_A,
          privateKey: `0x${"1".repeat(64)}`,
          slippageBps: 50,
          revertRiskBps: 10,
        },
        gas: {
          pollIntervalMs: 1000,
          priorityFeeFloorGwei: 1,
          priorityFeeCeilingGwei: 100,
          maxBidMultiplier: 2,
          eip1559Enabled: true,
          feeHistoryPercentile: 50,
          emaAlpha: 0.3,
          baseFeeBufferMultiplier: 1.1,
          maxPriorityFeePercentile: 75,
          historySize: 20,
          spikePriorityFeeMultiplier: 1.6,
        },
        rpc: { requestTimeoutMs: 5000, batchSize: 10, batchWaitMs: 10, polygonRpcUrls: [], chainstackRps: 1000 }, // high rps to disable low-infra scaling
        mempool: { coalesceTtlMs: 100 },
        paths: { dataDir: "/tmp", perfJsonFile: "perf.json" },
        observability: { logLevel: "silent" },
        envioApiToken: "",
        hasuraUrl: "http://localhost:8080/v1/graphql",
        hasuraSecret: "testing",
      },
      metrics: {
        cycles: 0,
        lastCycleDurationMs: 0,
        totalErrors: 0,
        lastErrorTime: null,
        lastErrorMessage: null,
        opportunitiesFound: 0,
        executionsAttempted: 0,
        executionsSuccessful: 0,
        executionsFailed: 0,
        executionReverts: 0,
        trackedRoutes: 0,
        startTime: Date.now(),
        peakCyclesPerMinute: 0,
        currentCyclesPerMinute: 0,
      },
      logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
      gasOracle: {
        getSnapshot: vi.fn().mockReturnValue({
          gasPrice: 30n * 10n ** 9n,
          baseFee: 30n * 10n ** 9n,
          priorityFee: 1n * 10n ** 9n,
          maxFee: 40n * 10n ** 9n,
          timestamp: Date.now(),
        }),
        getEffectiveMaxBidMultiplier: vi.fn().mockReturnValue(2),
      },
      isRunning: true,
      stateCache: stateWithPool,
      mempoolService: { start: vi.fn(), onSignal: vi.fn(), setKnownPools: vi.fn() },
      executionService: {
        start: vi.fn(),
        execute: mockExecute,
        batchExecute: vi.fn().mockImplementation(async (group) => {
          mockContext.isRunning = false;
          return group.map(() => ({ success: true, txHash: "0x1" }));
        }),
        tracker: mockTracker(),
        isQuarantined: vi.fn().mockReturnValue(false),
        getQuarantineManager: vi.fn().mockReturnValue({ add: vi.fn() }),
      },
      publicClient: {
        getBlock: vi.fn().mockResolvedValue({ baseFeePerGas: 30n * 10n ** 9n }),
        multicall: vi.fn().mockResolvedValue([]),
      },
      services: { register: vi.fn(), resolve: vi.fn(), has: vi.fn(), prepareAll: vi.fn(), startAll: vi.fn(), stopAll: vi.fn() },
      rpcCircuit: mockCircuitBreaker(),
      hasuraCircuit: mockCircuitBreaker(),
      tierManager: mockTierManager(),
    } as unknown as RuntimeContext;

    let execCalls = 0;
    mockExecute.mockImplementation(async () => {
      execCalls++;
      if (execCalls >= 2) mockContext.isRunning = false;
      return { success: true, txHash: "0x1" };
    });

    const deps: PassLoopDeps = {
      buildGraph: vi.fn().mockReturnValue({
        adjacency: new Map(),
        poolMeta: new Map(),
        stateRefs: new Map(),
        tokens: new Set(),
      }),
      findCycles: vi.fn().mockReturnValue([]),
      enumerateCycles: vi.fn().mockReturnValue([
        {
          edges: [
            {
              poolAddress: VALID_ADDR_B,
              tokenIn: VALID_ADDR_A,
              tokenOut: VALID_ADDR_C,
              protocol: "QUICKSWAP_V2",
              feeBps: 30n,
            },
          ],
          hopCount: 1,
          startToken: VALID_ADDR_A,
          logWeight: 0,
          cumulativeFeeBps: 30n,
        },
      ]),
      evaluatePipeline: vi.fn().mockReturnValue({
        profitable: [
          {
            cycle: {
              edges: [
                {
                  poolAddress: VALID_ADDR_B,
                  tokenIn: VALID_ADDR_A,
                  tokenOut: VALID_ADDR_C,
                  protocol: "QUICKSWAP_V2",
                  feeBps: 30n,
                },
              ],
              startToken: VALID_ADDR_A,
              hopCount: 1,
              logWeight: 0,
              cumulativeFeeBps: 30n,
            },
            result: {
              amountIn: 1000000n,
              amountOut: 2000000n,
              hopAmounts: [1000000n, 2000000n],
              tokenPath: [VALID_ADDR_A, VALID_ADDR_C],
              poolPath: [VALID_ADDR_B],
              profitable: true,
            },
            assessment: { netProfitAfterGas: 1000n, roi: 1000000 },
          },
          {
            cycle: {
              edges: [
                {
                  poolAddress: VALID_ADDR_B,
                  tokenIn: VALID_ADDR_A,
                  tokenOut: VALID_ADDR_C,
                  protocol: "QUICKSWAP_V2",
                  feeBps: 30n,
                },
              ],
              startToken: VALID_ADDR_A,
              hopCount: 1,
              logWeight: 0,
              cumulativeFeeBps: 30n,
            },
            result: {
              amountIn: 1000000n,
              amountOut: 2000000n,
              hopAmounts: [1000000n, 2000000n],
              tokenPath: [VALID_ADDR_A, VALID_ADDR_C],
              poolPath: [VALID_ADDR_B],
              profitable: true,
            },
            assessment: { netProfitAfterGas: 1000n, roi: 1000000 },
          },
        ],
        attempted: 2,
        profitableCount: 2,
      }),
      buildStateCacheFromGraphQL: vi.fn().mockResolvedValue(new Map()),
      routeKeyFromEdges: vi.fn((_edges: any, _start: any) => "mocked-route-key"),
      buildExecutionCandidate: vi.fn().mockReturnValue(MOCK_CANDIDATE_EXECUTION),
      instrumenter: { captureTrace: vi.fn() } as any,
      fetchTokenMetasFromHasura: vi.fn().mockResolvedValue(new Map()),
      fetchIndexerProgressFromHasura: vi.fn().mockResolvedValue(undefined),
      discoverPoolsFromHasura: vi
        .fn()
        .mockResolvedValue([{ address: "0xPool", protocol: "test", tokens: [VALID_ADDR_A, VALID_ADDR_C], fee: 30 }]),
    };

    await runPassLoop(mockContext, deps);

    expect(mockExecute).toHaveBeenCalledTimes(2);
  }, 15000);

  it("calls findCycles with configured maxHops (default 5) on re-enumeration", async () => {
    const mockContext = {
      config: {
        routing: {
          cycleRefreshIntervalMs: 0,
          maxHops: 5,
          enumerationMaxPaths: 5000,
          liquidityFloorUsd: 50,
        },
        execution: {
          minProfitWei: 0n,
          executorAddress: VALID_ADDR_A,
          privateKey: `0x${"1".repeat(64)}`,
          slippageBps: 50,
          revertRiskBps: 10,
        },
        gas: {
          pollIntervalMs: 1000,
          priorityFeeFloorGwei: 1,
          priorityFeeCeilingGwei: 100,
          maxBidMultiplier: 2,
          eip1559Enabled: true,
          feeHistoryPercentile: 50,
          emaAlpha: 0.3,
          baseFeeBufferMultiplier: 1.1,
          maxPriorityFeePercentile: 75,
          historySize: 20,
          spikePriorityFeeMultiplier: 1.6,
        },
        rpc: { requestTimeoutMs: 5000, batchSize: 10, batchWaitMs: 10, polygonRpcUrls: [], chainstackRps: 1000 }, // high rps to disable low-infra scaling
        mempool: { coalesceTtlMs: 100 },
        paths: { dataDir: "/tmp", perfJsonFile: "perf.json" },
        observability: { logLevel: "silent" },
        envioApiToken: "",
        hasuraUrl: "http://localhost:8080/v1/graphql",
        hasuraSecret: "testing",
      },
      metrics: {
        cycles: 0,
        lastCycleDurationMs: 0,
        totalErrors: 0,
        lastErrorTime: null,
        lastErrorMessage: null,
        opportunitiesFound: 0,
        executionsAttempted: 0,
        executionsSuccessful: 0,
        executionsFailed: 0,
        executionReverts: 0,
        trackedRoutes: 0,
        startTime: Date.now(),
        peakCyclesPerMinute: 0,
        currentCyclesPerMinute: 0,
      },
      logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
      gasOracle: {
        getSnapshot: vi.fn().mockReturnValue({
          gasPrice: 30n * 10n ** 9n,
          baseFee: 30n * 10n ** 9n,
          priorityFee: 1n * 10n ** 9n,
          maxFee: 40n * 10n ** 9n,
          timestamp: Date.now(),
        }),
        getEffectiveMaxBidMultiplier: vi.fn().mockReturnValue(2),
      },
      isRunning: true,
      stateCache: new Map(),
      mempoolService: { start: vi.fn(), onSignal: vi.fn(), setKnownPools: vi.fn() },
      executionService: {
        start: vi.fn(),
        execute: vi.fn(),
        tracker: mockTracker(),
        isQuarantined: vi.fn().mockReturnValue(false),
        getQuarantineManager: vi.fn().mockReturnValue({ add: vi.fn() }),
      },
      publicClient: {
        getBlock: vi.fn().mockResolvedValue({ baseFeePerGas: 30n * 10n ** 9n }),
        multicall: vi.fn().mockResolvedValue([]),
      },
      services: { register: vi.fn(), resolve: vi.fn(), has: vi.fn(), prepareAll: vi.fn(), startAll: vi.fn(), stopAll: vi.fn() },
      rpcCircuit: mockCircuitBreaker(),
      hasuraCircuit: mockCircuitBreaker(),
      tierManager: mockTierManager(),
    } as unknown as RuntimeContext;

    const enumerateCyclesSpy = vi.fn().mockImplementation(() => {
      mockContext.isRunning = false;
      return [];
    });
    const deps: PassLoopDeps = {
      buildGraph: vi.fn().mockReturnValue({
        adjacency: new Map(),
        poolMeta: new Map(),
        stateRefs: new Map(),
        tokens: new Set(),
      }),
      findCycles: vi.fn().mockReturnValue([]),
      enumerateCycles: enumerateCyclesSpy,
      evaluatePipeline: vi.fn().mockReturnValue({ profitable: [], attempted: 0, profitableCount: 0 }),
      buildStateCacheFromGraphQL: vi.fn().mockResolvedValue(new Map()),
      routeKeyFromEdges: vi.fn(),
      buildExecutionCandidate: vi.fn(),
      instrumenter: { captureTrace: vi.fn() } as any,
      fetchTokenMetasFromHasura: vi.fn().mockResolvedValue(new Map()),
      fetchIndexerProgressFromHasura: vi.fn().mockResolvedValue(undefined),
      discoverPoolsFromHasura: vi
        .fn()
        .mockResolvedValue([{ address: "0xPool", protocol: "test", tokens: [VALID_ADDR_A, VALID_ADDR_C], fee: 30 }]),
    };

    await runPassLoop(mockContext, deps);

    expect(enumerateCyclesSpy).toHaveBeenCalledWith(expect.anything(), 5, 5000, expect.any(Function));
  });
});
