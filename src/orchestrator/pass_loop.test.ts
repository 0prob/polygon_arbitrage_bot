import { describe, it, expect, vi } from "vitest";
import { runPassLoop } from "./pass_loop.ts";
import type { PassLoopDeps } from "./loop.ts";
import type { RuntimeContext } from "./boot.ts";
import type { CandidateExecution } from "../services/execution/service.ts";
import { WMATIC } from "../config/addresses.ts";
import { SwapUsdValuator } from "../services/mempool/swap_usd_valuation.ts";

vi.mock("../pipeline/fetcher.ts", () => ({
  fetchMissingPoolState: vi.fn().mockResolvedValue(new Set()),
}));

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
    logOpportunityFeatures: vi.fn().mockResolvedValue(undefined),
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

function mockSwapUsdValuator() {
  return new SwapUsdValuator(10_000);
}

const MOCK_POOL = {
  address: VALID_ADDR_B as `0x${string}`,
  protocol: "QUICKSWAP_V2",
  token0: WMATIC,
  token1: VALID_ADDR_C as `0x${string}`,
  tokens: [WMATIC, VALID_ADDR_C] as `0x${string}`[],
  fee: 30,
};

function mockStateRefresh(overrides: { pools?: typeof MOCK_POOL[] } = {}) {
  const service = {
    Pools: overrides.pools ?? [MOCK_POOL],
    TokenMetas: new Map([[WMATIC.toLowerCase(), { decimals: 18 }]]),
    runLfStateRefresh: vi.fn().mockResolvedValue(undefined),
    triggerDiscovery: vi.fn().mockResolvedValue(undefined),
    isBootstrapInProgress: false,
    stop: vi.fn(),
  };
  return service;
}

function mockStateCache(initial?: [string, Record<string, unknown>][]) {
  const cache = new Map<string, Record<string, unknown>>(initial) as Map<string, Record<string, unknown>> & {
    liveSize: () => number;
  };
  cache.liveSize = function liveSize() {
    return this.size;
  };
  return cache;
}

const stateWithPool = mockStateCache([
  [VALID_ADDR_B.toLowerCase(), { initialized: true, reserve0: 1000n, reserve1: 1000n }],
]);

const mockCycle = {
  edges: [
    {
      poolAddress: VALID_ADDR_B,
      tokenIn: WMATIC,
      tokenOut: VALID_ADDR_C,
      protocol: "QUICKSWAP_V2",
      feeBps: 30n,
      zeroForOne: true,
      tokenInIdx: 0,
      tokenOutIdx: 1,
    },
  ],
  hopCount: 1,
  startToken: WMATIC,
  logWeight: 0,
  cumulativeFeeBps: 30n,
};

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
        ranking: { mode: "off" as const, modelPath: "data/ranking-model.json" },
        sync: { headDrivenRefresh: false, headRefreshMaxPools: 50 },
        oracle: { enabled: false, pythHermesUrl: "", maxDivergenceBps: 500 },
        mev: {
          enabled: false,
          fastlaneRelayUrl: "",
          publicBackrunFallback: true,
          jitEnabled: false,
          sandwichEnabled: false,
          maxBidBps: 500,
        },
        execution: {
          minProfitWei: 0n,
          executorAddress: VALID_ADDR_A,
          privateKey: `0x${"1".repeat(64)}`,
          slippageBps: 50,
          revertRiskBps: 10,
          minLiquidityV3Rate: 0n,
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
        tickNonceRecovery: vi.fn().mockResolvedValue(undefined),
        tracker: mockTracker(),
        isQuarantined: vi.fn().mockReturnValue(false),
        getQuarantineManager: vi.fn().mockReturnValue({
          add: vi.fn(),
          isQuarantined: vi.fn().mockReturnValue(false),
          revision: 0,
          size: 0,
        }),
      },
      publicClient: {
        getBlock: vi.fn().mockResolvedValue({ baseFeePerGas: 30n * 10n ** 9n }),
        multicall: vi.fn().mockResolvedValue([]),
      },
      services: { register: vi.fn(), resolve: vi.fn(), has: vi.fn(), prepareAll: vi.fn(), startAll: vi.fn(), stopAll: vi.fn() },
      rpcCircuit: mockCircuitBreaker(),
      hasuraCircuit: mockCircuitBreaker(),
      tierManager: mockTierManager(),
      stateRefreshService: mockStateRefresh(),
      swapUsdValuator: mockSwapUsdValuator(),
    } as unknown as RuntimeContext;

    let execCalls = 0;
    mockExecute.mockImplementation(async () => {
      execCalls++;
      if (execCalls >= 2) mockContext.isRunning = false;
      return { success: true, txHash: "0x1" };
    });

    const mockCycles = [
      { ...mockCycle, id: "route-1" },
      { ...mockCycle, id: "route-2" },
    ];
    const deps: PassLoopDeps = {
      buildGraph: vi.fn().mockReturnValue({
        adjacency: new Map(),
        poolMeta: new Map(),
        stateRefs: new Map(),
        tokens: new Set(),
      }),
      enumerateCycles: vi.fn(),
      findCyclesMultiPass: vi.fn().mockResolvedValue(mockCycles),
      finalizeEnumeratedCycles: vi.fn((_g, raw) => raw),
      evaluatePipeline: vi.fn().mockResolvedValue({
        profitable: [
          {
            cycle: { ...mockCycle, id: "route-1" },
            result: {
              amountIn: 1000000n,
              amountOut: 2000000n,
              hopAmounts: [1000000n, 2000000n],
              tokenPath: [WMATIC, VALID_ADDR_C],
              poolPath: [VALID_ADDR_B],
              profitable: true,
            },
            assessment: {
              netProfitAfterGas: 1000n,
              netProfitAfterGasMaticWei: 1000n,
              roi: 1000000,
              shouldExecute: true,
            },
          },
          {
            cycle: { ...mockCycle, id: "route-2" },
            result: {
              amountIn: 1000000n,
              amountOut: 2000000n,
              hopAmounts: [1000000n, 2000000n],
              tokenPath: [WMATIC, VALID_ADDR_C],
              poolPath: [VALID_ADDR_B],
              profitable: true,
            },
            assessment: {
              netProfitAfterGas: 1000n,
              netProfitAfterGasMaticWei: 1000n,
              roi: 1000000,
              shouldExecute: true,
            },
          },
        ],
        attempted: 2,
        profitableCount: 2,
        simulated: 2,
        pruned: 0,
        prunedMissingState: 0,
        prunedInvalidBounds: 0,
        prunedNoGrossProfit: 0,
        prunedFinalCheckFailed: 0,
        noRate: 0,
      }),
      routeKeyFromEdges: vi.fn((_edges: unknown, idx?: number) => `mocked-route-key-${idx ?? 0}`),
      buildExecutionCandidate: vi.fn().mockReturnValue(MOCK_CANDIDATE_EXECUTION),
      instrumenter: { captureTrace: vi.fn() } as any,
    };

    await runPassLoop(mockContext, deps);

    expect(mockExecute).toHaveBeenCalledTimes(2);
  }, 15000);

  it("calls findCyclesMultiPass with configured maxHops (default 5) on re-enumeration", async () => {
    const mockContext = {
      config: {
        routing: {
          cycleRefreshIntervalMs: 0,
          maxHops: 5,
          enumerationMaxPaths: 5000,
          liquidityFloorUsd: 50,
        },
        ranking: { mode: "off" as const, modelPath: "data/ranking-model.json" },
        sync: { headDrivenRefresh: false, headRefreshMaxPools: 50 },
        oracle: { enabled: false, pythHermesUrl: "", maxDivergenceBps: 500 },
        mev: {
          enabled: false,
          fastlaneRelayUrl: "",
          publicBackrunFallback: true,
          jitEnabled: false,
          sandwichEnabled: false,
          maxBidBps: 500,
        },
        execution: {
          minProfitWei: 0n,
          executorAddress: VALID_ADDR_A,
          privateKey: `0x${"1".repeat(64)}`,
          slippageBps: 50,
          revertRiskBps: 10,
          minLiquidityV3Rate: 0n,
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
      stateCache: mockStateCache(),
      mempoolService: { start: vi.fn(), onSignal: vi.fn(), setKnownPools: vi.fn() },
      executionService: {
        start: vi.fn(),
        execute: vi.fn(),
        tickNonceRecovery: vi.fn().mockResolvedValue(undefined),
        tracker: mockTracker(),
        isQuarantined: vi.fn().mockReturnValue(false),
        getQuarantineManager: vi.fn().mockReturnValue({
          add: vi.fn(),
          isQuarantined: vi.fn().mockReturnValue(false),
          revision: 0,
          size: 0,
        }),
      },
      publicClient: {
        getBlock: vi.fn().mockResolvedValue({ baseFeePerGas: 30n * 10n ** 9n }),
        multicall: vi.fn().mockResolvedValue([]),
      },
      services: { register: vi.fn(), resolve: vi.fn(), has: vi.fn(), prepareAll: vi.fn(), startAll: vi.fn(), stopAll: vi.fn() },
      rpcCircuit: mockCircuitBreaker(),
      hasuraCircuit: mockCircuitBreaker(),
      tierManager: mockTierManager(),
      stateRefreshService: mockStateRefresh(),
      swapUsdValuator: mockSwapUsdValuator(),
    } as unknown as RuntimeContext;

    const findCyclesMultiPassSpy = vi.fn().mockImplementation(async () => {
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
      enumerateCycles: vi.fn(),
      findCyclesMultiPass: findCyclesMultiPassSpy,
      finalizeEnumeratedCycles: vi.fn((_, raw) => raw),
      evaluatePipeline: vi.fn().mockResolvedValue({
        profitable: [],
        attempted: 0,
        profitableCount: 0,
        simulated: 0,
        pruned: 0,
        prunedMissingState: 0,
        prunedInvalidBounds: 0,
        prunedNoGrossProfit: 0,
        prunedFinalCheckFailed: 0,
        noRate: 0,
      }),
      routeKeyFromEdges: vi.fn(),
      buildExecutionCandidate: vi.fn(),
      instrumenter: { captureTrace: vi.fn() } as any,
    };

    await runPassLoop(mockContext, deps);

    expect(findCyclesMultiPassSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({ maxHops: 2 }),
        expect.objectContaining({ maxHops: 3 }),
        expect.objectContaining({ maxHops: 5, maxCycles: 5000 }),
      ]),
      expect.anything(),
    );
  }, 15000);

  it("uses Bellman-Ford cycle enumeration if cycleFinder is configured to 'bellman-ford'", async () => {
    const mockContext = {
      config: {
        routing: {
          cycleRefreshIntervalMs: 0,
          maxHops: 5,
          enumerationMaxPaths: 5000,
          liquidityFloorUsd: 50,
          cycleFinder: "bellman-ford",
        },
        ranking: { mode: "off" as const, modelPath: "data/ranking-model.json" },
        sync: { headDrivenRefresh: false, headRefreshMaxPools: 50 },
        oracle: { enabled: false, pythHermesUrl: "", maxDivergenceBps: 500 },
        mev: {
          enabled: false,
          fastlaneRelayUrl: "",
          publicBackrunFallback: true,
          jitEnabled: false,
          sandwichEnabled: false,
          maxBidBps: 500,
        },
        execution: {
          minProfitWei: 0n,
          executorAddress: VALID_ADDR_A,
          privateKey: `0x${"1".repeat(64)}`,
          slippageBps: 50,
          revertRiskBps: 10,
          minLiquidityV3Rate: 0n,
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
        rpc: { requestTimeoutMs: 5000, batchSize: 10, batchWaitMs: 10, polygonRpcUrls: [], chainstackRps: 1000 },
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
      stateCache: mockStateCache(),
      mempoolService: { start: vi.fn(), onSignal: vi.fn(), setKnownPools: vi.fn() },
      executionService: {
        start: vi.fn(),
        execute: vi.fn(),
        tickNonceRecovery: vi.fn().mockResolvedValue(undefined),
        tracker: mockTracker(),
        isQuarantined: vi.fn().mockReturnValue(false),
        getQuarantineManager: vi.fn().mockReturnValue({
          add: vi.fn(),
          isQuarantined: vi.fn().mockReturnValue(false),
          revision: 0,
          size: 0,
        }),
      },
      publicClient: {
        getBlock: vi.fn().mockResolvedValue({ baseFeePerGas: 30n * 10n ** 9n }),
        multicall: vi.fn().mockResolvedValue([]),
      },
      services: { register: vi.fn(), resolve: vi.fn(), has: vi.fn(), prepareAll: vi.fn(), startAll: vi.fn(), stopAll: vi.fn() },
      rpcCircuit: mockCircuitBreaker(),
      hasuraCircuit: mockCircuitBreaker(),
      tierManager: mockTierManager(),
      stateRefreshService: mockStateRefresh(),
      swapUsdValuator: mockSwapUsdValuator(),
    } as unknown as RuntimeContext;

    // Timer to stop the loop: HF never calls evaluatePipeline when cycles are empty,
    // so the Bellman-Ford enumeration runs in the background via LF microtask.
    // This timer stops the loop after the LF tick has had a chance to execute.
    const stopTimer = setTimeout(() => { mockContext.isRunning = false; }, 100);

    const findCyclesMultiPassSpy = vi.fn();
    const bfMultiPassSpy = vi.fn().mockResolvedValue([]);

    const deps: PassLoopDeps = {
      buildGraph: vi.fn().mockReturnValue({
        adjacency: new Map(),
        poolMeta: new Map(),
        stateRefs: new Map(),
        tokens: new Set(),
      }),
      enumerateCycles: vi.fn(),
      findCyclesMultiPass: findCyclesMultiPassSpy,
      findCyclesBellmanFordMultiPass: bfMultiPassSpy,
      finalizeEnumeratedCycles: vi.fn((_, raw) => raw),
      evaluatePipeline: vi.fn().mockReturnValue({ profitable: [], attempted: 0, profitableCount: 0 }),
      routeKeyFromEdges: vi.fn(),
      buildExecutionCandidate: vi.fn(),
      instrumenter: { captureTrace: vi.fn() } as any,
    };

    await runPassLoop(mockContext, deps);

    clearTimeout(stopTimer);

    expect(findCyclesMultiPassSpy).not.toHaveBeenCalled();
    expect(bfMultiPassSpy).toHaveBeenCalled();
  });
});
