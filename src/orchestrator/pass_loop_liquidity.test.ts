import { describe, it, expect, vi } from "vitest";
import { runPassLoop, type PassLoopDeps } from "./pass_loop.ts";
import type { RuntimeContext } from "./boot.ts";
import type { CandidateExecution } from "../services/execution/service.ts";
import { PoolMeta } from "../core/types/pool.ts";

const MOCK_CANDIDATE_EXECUTION: CandidateExecution = {
  routeKey: "0x1234567890123456789012345678901234567890",
  calldata: "0xdeadbeef",
  targetAddress: "0x0000000000000000000000000000000000000001",
  value: 0n,
};

describe("runPassLoop liquidity filtering", () => {
  it("filters pools based on liquidity floor", async () => {
    const mockContext = {
      config: {
        routing: { cycleRefreshIntervalMs: 0, maxHops: 2, liquidityFloorUsd: 1000n },
        execution: { minProfitWei: 0n, executorAddress: "0x1", slippageBps: 50, revertRiskBps: 10 },
        gas: { pollIntervalMs: 1000, priorityFeeFloorGwei: 1, priorityFeeCeilingGwei: 100, maxBidMultiplier: 2 },
        rpc: { requestTimeoutMs: 5000, batchSize: 10, batchWaitMs: 10, polygonRpcUrls: [] },
        mempool: { coalesceTtlMs: 100 },
        paths: { dataDir: "/tmp", perfJsonFile: "perf.json" },
        observability: { logLevel: "silent" },
        hasuraUrl: "http://localhost:8080/v1/graphql",
        hasuraSecret: "testing",
      },
      logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
      isRunning: true,
      stateCache: new Map<string, Record<string, unknown>>(),
      mempoolService: { start: vi.fn() },
      executionService: { start: vi.fn() },
      gasOracle: { getSnapshot: vi.fn().mockReturnValue({ gasPrice: 1n }) },
      crossChainScanner: { findProfitableRoutes: vi.fn().mockResolvedValue([]) },
      getPools: vi.fn().mockReturnValue([
        { address: "0xLowLiquidity", protocol: "uniswap_v2", token0: "0x1", token1: "0x2", tokens: ["0x1", "0x2"] },
        { address: "0xHighLiquidity", protocol: "uniswap_v2", token0: "0x1", token1: "0x2", tokens: ["0x1", "0x2"] },
      ]),
    } as unknown as RuntimeContext;

    // Simulate run
    setTimeout(() => mockContext.isRunning = false, 100);

    // Simulate high/low liquidity
    mockContext.stateCache.set("0xlowliquidity", { reserve0: 1n, reserve1: 1n });
    mockContext.stateCache.set("0xhighliquidity", { reserve0: 10n**20n, reserve1: 10n**20n });

    const deps = {
        buildGraph: vi.fn().mockReturnValue({ adjacency: new Map(), poolMeta: new Map(), stateRefs: new Map(), tokens: new Set() }),
        enumerateCycles: vi.fn().mockReturnValue([]),
    } as any;

    await runPassLoop(mockContext, deps);

    expect(deps.buildGraph).toHaveBeenCalled();
    const poolsPassed = deps.buildGraph.mock.calls[0][0] as PoolMeta[];
    expect(poolsPassed.length).toBe(1);
    expect(poolsPassed[0].address).toBe("0xHighLiquidity");
  });
});
