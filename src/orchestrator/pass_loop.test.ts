import { describe, it, expect, vi } from "vitest";
import { runPassLoop, type PassLoopDeps } from "./pass_loop.ts";
import type { RuntimeContext } from "./boot.ts";
import type { CandidateExecution } from "../services/execution/service.ts";

const MOCK_CANDIDATE_EXECUTION: CandidateExecution = {
  routeKey: "0x1234567890123456789012345678901234567890",
  calldata: "0xdeadbeef",
  targetAddress: "0x0000000000000000000000000000000000000001",
  value: 0n,
};

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
        routing: { cycleRefreshIntervalMs: 0, maxHops: 2 },
        execution: { minProfitWei: 0n, executorAddress: VALID_ADDR_A, slippageBps: 50, revertRiskBps: 10 },
        gas: { pollIntervalMs: 1000, priorityFeeFloorGwei: 1, priorityFeeCeilingGwei: 100, maxBidMultiplier: 2 },
        rpc: { requestTimeoutMs: 5000, batchSize: 10, batchWaitMs: 10, polygonRpcUrls: [] },
        mempool: { coalesceTtlMs: 100 },
        discovery: { refreshIntervalMs: 60000, concurrency: 1 },
        paths: { dataDir: "/tmp", perfJsonFile: "perf.json" },
        observability: { logLevel: "silent" },
        envioApiToken: "",
        hasuraUrl: "http://localhost:8080/v1/graphql",
        hasuraSecret: "testing",
      },
      metrics: {
        cycles: 0, lastCycleDurationMs: 0, totalErrors: 0,
        lastErrorTime: null, lastErrorMessage: null,
        opportunitiesFound: 0, executionsAttempted: 0,
        executionsSuccessful: 0, executionsFailed: 0,
        startTime: Date.now(), peakCyclesPerMinute: 0, currentCyclesPerMinute: 0,
      },
      logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
      gasOracle: {
        getSnapshot: vi.fn().mockReturnValue({ 
          gasPrice: 30n * 10n ** 9n, 
          baseFee: 30n * 10n ** 9n, 
          priorityFee: 1n * 10n ** 9n,
          maxFee: 40n * 10n ** 9n,
          timestamp: Date.now()
        }),
      },
      isRunning: true,
      stateCache: stateWithPool,
      mempoolService: { start: vi.fn(), onSignal: vi.fn() },
      executionService: { start: vi.fn(), execute: mockExecute },
      getPools: vi.fn().mockReturnValue([{ address: "0xPool", protocol: "test", token0: "", token1: "", tokens: [] }]),
      publicClient: { getBlock: vi.fn().mockResolvedValue({ baseFeePerGas: 30n * 10n ** 9n }) },
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
      findCycles: vi.fn().mockReturnValue([
        {
          edges: [
            {
              poolAddress: VALID_ADDR_B,
              tokenIn: VALID_ADDR_A,
              tokenOut: VALID_ADDR_C,
              protocol: "quickswap_v2",
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
                  protocol: "quickswap_v2",
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
              amountOut: 1000000n,
              hopAmounts: [1000000n, 2000000n],
              tokenPath: [VALID_ADDR_A, VALID_ADDR_C],
              poolPath: [VALID_ADDR_B],
            },
            assessment: { netProfitAfterGas: 0n, roi: 0 },
          },
          {
            cycle: {
              edges: [
                {
                  poolAddress: VALID_ADDR_B,
                  tokenIn: VALID_ADDR_A,
                  tokenOut: VALID_ADDR_C,
                  protocol: "quickswap_v2",
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
              amountOut: 1000000n,
              hopAmounts: [1000000n, 2000000n],
              tokenPath: [VALID_ADDR_A, VALID_ADDR_C],
              poolPath: [VALID_ADDR_B],
            },
            assessment: { netProfitAfterGas: 0n, roi: 0 },
          },
        ],
        attempted: 2,
        profitableCount: 2,
      }),
      buildStateCacheFromGraphQL: vi.fn().mockResolvedValue(new Map()),
      discoverPoolsFromHasura: vi.fn().mockResolvedValue([]),
      routeKeyFromEdges: vi.fn().mockReturnValue("mocked-route-key"),
      buildExecutionCandidate: vi.fn().mockReturnValue(MOCK_CANDIDATE_EXECUTION),
    };

    await runPassLoop(mockContext, deps);

    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it("calls findCycles with maxHops=4 on re-enumeration", async () => {
    const mockContext = {
      config: {
        routing: { cycleRefreshIntervalMs: 0, maxHops: 4 },
        execution: { minProfitWei: 0n, executorAddress: VALID_ADDR_A, slippageBps: 50, revertRiskBps: 10 },
        gas: { pollIntervalMs: 1000, priorityFeeFloorGwei: 1, priorityFeeCeilingGwei: 100, maxBidMultiplier: 2 },
        rpc: { requestTimeoutMs: 5000, batchSize: 10, batchWaitMs: 10, polygonRpcUrls: [] },
        mempool: { coalesceTtlMs: 100 },
        discovery: { refreshIntervalMs: 60000, concurrency: 1 },
        paths: { dataDir: "/tmp", perfJsonFile: "perf.json" },
        observability: { logLevel: "silent" },
        envioApiToken: "",
        hasuraUrl: "http://localhost:8080/v1/graphql",
        hasuraSecret: "testing",
      },
      metrics: {
        cycles: 0, lastCycleDurationMs: 0, totalErrors: 0,
        lastErrorTime: null, lastErrorMessage: null,
        opportunitiesFound: 0, executionsAttempted: 0,
        executionsSuccessful: 0, executionsFailed: 0,
        startTime: Date.now(), peakCyclesPerMinute: 0, currentCyclesPerMinute: 0,
      },
      logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
      gasOracle: {
        getSnapshot: vi.fn().mockReturnValue({ 
          gasPrice: 30n * 10n ** 9n, 
          baseFee: 30n * 10n ** 9n, 
          priorityFee: 1n * 10n ** 9n,
          maxFee: 40n * 10n ** 9n,
          timestamp: Date.now()
        }),
      },
      isRunning: true,
      stateCache: new Map(),
      mempoolService: { start: vi.fn(), onSignal: vi.fn() },
      executionService: { start: vi.fn(), execute: vi.fn() },
      getPools: vi.fn().mockReturnValue([{ address: "0xPool", protocol: "test", token0: "", token1: "", tokens: [] }]),
    } as unknown as RuntimeContext;

    const findCyclesSpy = vi.fn().mockImplementation(() => {
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
      findCycles: findCyclesSpy,
      evaluatePipeline: vi.fn().mockReturnValue({ profitable: [], attempted: 0, profitableCount: 0 }),
      buildStateCacheFromGraphQL: vi.fn().mockResolvedValue(new Map()),
      discoverPoolsFromHasura: vi.fn().mockResolvedValue([]),
      routeKeyFromEdges: vi.fn(),
      buildExecutionCandidate: vi.fn(),
    };

    await runPassLoop(mockContext, deps);

    expect(findCyclesSpy).toHaveBeenCalledWith(expect.anything(), 4);
  });
});
