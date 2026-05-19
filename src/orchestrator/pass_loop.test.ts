import { describe, it, expect, vi } from "vitest";
import { runPassLoop } from "./pass_loop.ts";
import type { RuntimeContext } from "./boot.ts";
import { evaluatePipeline } from "../services/strategy/pipeline.ts";
import { buildGraph } from "../services/strategy/graph.ts";
import { enumerateCycles } from "../services/strategy/finder.ts";

vi.mock("../services/strategy/pipeline.ts", () => ({
  evaluatePipeline: vi.fn(),
}));

vi.mock("../services/strategy/graph.ts", () => ({
  buildGraph: vi.fn(),
}));

vi.mock("../services/strategy/finder.ts", () => ({
  enumerateCycles: vi.fn(),
  routeKeyFromEdges: vi.fn().mockReturnValue("mocked-route-key"),
}));

const MOCK_BUILD_ARB_TX_RETURN = {
  to: "0x0000000000000000000000000000000000000001" as `0x${string}`,
  data: "0xdeadbeef" as `0x${string}`,
  value: 0n,
  routeHash: "0x1234567890123456789012345678901234567890" as `0x${string}`,
  calls: [] as Array<unknown>,
  meta: {} as Record<string, unknown>,
};

vi.mock("../services/execution/builder.ts", () => ({
  buildArbTx: vi.fn(() => MOCK_BUILD_ARB_TX_RETURN),
}));

vi.mock("../infra/db/hyperindex_reader.ts", () => ({
  buildStateCacheFromHyperIndex: vi.fn().mockReturnValue(new Map()),
}));

const VALID_ADDR_A = "0x0000000000000000000000000000000000000001";
const VALID_ADDR_B = "0x0000000000000000000000000000000000000002";
const VALID_ADDR_C = "0x0000000000000000000000000000000000000003";

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
        paths: { dataDir: "/tmp", dbFile: "test.db" },
        observability: { logLevel: "silent" },
        envioApiToken: "",
      },
      logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
      isRunning: true,
      db: {},
      stateCache: new Map() as any,
      hiDbPath: "/tmp/test.db",
      mempoolService: { start: vi.fn() },
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

    vi.mocked(buildGraph).mockReturnValue({
      adjacency: new Map(),
      poolMeta: new Map(),
      stateRefs: new Map(),
      tokens: new Set(),
    } as any);
    vi.mocked(enumerateCycles).mockReturnValue([
      {
        edges: [{
          poolAddress: VALID_ADDR_B,
          tokenIn: VALID_ADDR_A,
          tokenOut: VALID_ADDR_C,
          protocol: "quickswap_v2",
          feeBps: 30n,
        }],
        hopCount: 1,
        startToken: VALID_ADDR_A,
        logWeight: 0,
        cumulativeFeeBps: 30n,
      },
    ]);

    const mockProfitable = [
      {
        cycle: {
          edges: [{
            poolAddress: VALID_ADDR_B,
            tokenIn: VALID_ADDR_A,
            tokenOut: VALID_ADDR_C,
            protocol: "quickswap_v2",
            feeBps: 30n,
          }],
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
          edges: [{
            poolAddress: VALID_ADDR_B,
            tokenIn: VALID_ADDR_A,
            tokenOut: VALID_ADDR_C,
            protocol: "quickswap_v2",
            feeBps: 30n,
          }],
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
    ];
    vi.mocked(evaluatePipeline).mockReturnValue({ profitable: mockProfitable as any, attempted: 2, profitableCount: 2 });

    await runPassLoop(mockContext);

    expect(mockExecute).toHaveBeenCalledTimes(2);
  });
});
