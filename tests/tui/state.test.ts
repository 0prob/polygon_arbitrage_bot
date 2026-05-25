import { describe, it, expect } from "vitest";
import { createInitialState, applyEvent } from "../../src/tui/state.ts";

describe("createInitialState", () => {
  it("returns zeroed metrics", () => {
    const s = createInitialState();
    expect(s.metrics.opportunitiesFound).toBe(0);
    expect(s.metrics.executed).toBe(0);
    expect(s.metrics.successful).toBe(0);
    expect(s.metrics.failed).toBe(0);
    expect(s.metrics.totalProfitWei).toBe(0n);
  });

  it("starts with isRunning false", () => {
    const s = createInitialState();
    expect(s.isRunning).toBe(false);
  });
});

describe("applyEvent", () => {
  it("increments opportunitiesFound on opportunity_found", () => {
    const s = createInitialState();
    applyEvent(s, { type: "opportunity_found", routeKey: "a", profitWei: 100n });
    expect(s.metrics.opportunitiesFound).toBe(1);
    expect(s.metrics.totalProfitWei).toBe(100n);
  });

  it("tracks execution result counts", () => {
    const s = createInitialState();
    applyEvent(s, { type: "execution_result", routeKey: "a", success: true });
    applyEvent(s, { type: "execution_result", routeKey: "b", success: false, error: "fail" });
    expect(s.metrics.executed).toBe(2);
    expect(s.metrics.successful).toBe(1);
    expect(s.metrics.failed).toBe(1);
  });

  it("updates system gas price on gas_snapshot", () => {
    const s = createInitialState();
    applyEvent(s, { type: "gas_snapshot", gasPrice: 32n * 10n ** 9n });
    expect(s.system.gasPriceWei).toBe(32n * 10n ** 9n);
  });

  it("updates pool count on graph_built but does not log", () => {
    const s = createInitialState();
    applyEvent(s, { type: "graph_built", poolCount: 184, cycleCount: 42, maxHops: 4 });
    expect(s.system.poolCount).toBe(184);
    expect(s.system.cycleCount).toBe(42);
    expect(s.log.length).toBe(0); // Assuming no other events fired
  });

  it("updates pipeline stage and simulation progress", () => {
    const s = createInitialState();
    applyEvent(s, { type: "pipeline_stage", stage: "SIMULATING" });
    expect(s.system.pipelineStage).toBe("SIMULATING");
    
    applyEvent(s, { type: "simulation_progress", current: 50, total: 100, profitable: 2 });
    expect(s.system.simProgress.current).toBe(50);
    expect(s.system.simProgress.profitable).toBe(2);
  });

  it("updates active opportunities on execution_result", () => {
    const s = createInitialState();
    applyEvent(s, { type: "opportunity_found", routeKey: "0x1:0x2", profitWei: 100n });
    expect(s.system.activeOpportunities.length).toBe(1);
    expect(s.system.activeOpportunities[0].status).toBe("Simulated");
    
    applyEvent(s, { type: "execution_result", routeKey: "0x1:0x2", success: true });
    expect(s.system.activeOpportunities[0].status).toBe("Confirmed");
  });

  it("appends to log on error events", () => {
    const s = createInitialState();
    applyEvent(s, { type: "error", component: "PassLoop", message: "oops" });
    expect(s.log.length).toBe(1);
    expect(s.log[0].component).toBe("PassLoop");
  });

  it("caps log at 1000 entries", () => {
    const s = createInitialState();
    for (let i = 0; i < 1001; i++) {
      applyEvent(s, { type: "error", component: "test", message: String(i) });
    }
    expect(s.log.length).toBe(1000);
    expect(s.log[0].component).toBe("test");
    expect(s.log[999].component).toBe("test");
  });
});
