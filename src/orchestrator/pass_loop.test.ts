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

describe("runPassLoop", () => {
  it("updates currentActivityProgress during execution", async () => {
    const mockStateUpdate = vi.fn();
    const mockExecute = vi.fn().mockResolvedValue({ success: true, txHash: "0x1" });
    
    const mockContext = {
      config: {
        routing: { cycleRefreshIntervalMs: 100, maxHops: 2 },
        execution: { minProfitWei: 0n },
      },
      logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
      isRunning: true,
      watcherService: { start: vi.fn(), getStateCache: vi.fn().mockReturnValue(new Map()) },
      hydrationService: { start: vi.fn() },
      discoveryService: { start: vi.fn() },
      mempoolService: { start: vi.fn() },
      executionService: { start: vi.fn(), execute: mockExecute },
      getPools: vi.fn().mockReturnValue([{ address: "0xPool", protocol: "test", tokens: [] }]),
      publicClient: { getBlock: vi.fn().mockResolvedValue({ baseFeePerGas: 30n * 10n ** 9n }) },
    } as unknown as RuntimeContext;

    // Simulate only one pass
    mockContext.isRunning = false;

    // Mock graph/cycles
    vi.mocked(buildGraph).mockReturnValue({});
    vi.mocked(enumerateCycles).mockReturnValue([{ edges: [], hopCount: 1, startToken: "0x1" }]);

    // Mock profitable opportunities
    const mockProfitable = [
      { cycle: { edges: [], startToken: "0x1" }, result: {}, assessment: {} },
      { cycle: { edges: [], startToken: "0x1" }, result: {}, assessment: {} }
    ];
    vi.mocked(evaluatePipeline).mockReturnValue({ profitable: mockProfitable, attempted: 2, profitableCount: 2 });

    await runPassLoop(mockContext, mockStateUpdate);

    // Verify progress updates
    console.log("mockStateUpdate calls:", mockStateUpdate.mock.calls.length);
    mockStateUpdate.mock.calls.forEach((call, i) => console.log(`Call ${i}:`, JSON.stringify(call[0])));

    expect(mockStateUpdate).toHaveBeenCalledWith(expect.objectContaining({
      currentActivityProgress: { label: "Executing", completed: 1, total: 2, unit: "txs" }
    }));
    expect(mockStateUpdate).toHaveBeenCalledWith(expect.objectContaining({
      currentActivityProgress: { label: "Executing", completed: 2, total: 2, unit: "txs" }
    }));
  });
});
