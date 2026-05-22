import { describe, it, expect, vi } from "vitest";
import { Renderer } from "../../src/tui/renderer.ts";
import { computeLayout } from "../../src/tui/layout.ts";
import { createInitialState, applyEvent } from "../../src/tui/state.ts";

function createMockStdout() {
  let buffer = "";
  return {
    write: vi.fn((chunk: string) => { buffer += chunk; }),
    getBuffer: () => buffer,
    columns: 80,
    rows: 24,
  } as any;
}

describe("Renderer", () => {
  it("enters alternate screen on enter()", () => {
    const stdout = createMockStdout();
    const r = new Renderer(stdout);
    r.enter();
    expect(stdout.write).toHaveBeenCalledWith(expect.stringContaining("?1049h"));
  });

  it("exits alternate screen on exit()", () => {
    const stdout = createMockStdout();
    const r = new Renderer(stdout);
    r.enter();
    stdout.write.mockClear();
    r.exit();
    expect(stdout.write).toHaveBeenCalledWith(expect.stringContaining("?1049l"));
  });

  it("renders status bar with title", () => {
    const stdout = createMockStdout();
    const r = new Renderer(stdout);
    const layout = computeLayout(80, 24);
    const state = createInitialState();
    state.isRunning = true;

    r.render(layout, state);
    const output = stdout.getBuffer();
    expect(output).toContain("Arb Bot");
  });

  it("renders metrics panel with counts", () => {
    const stdout = createMockStdout();
    const r = new Renderer(stdout);
    const layout = computeLayout(80, 24);
    const state = createInitialState();
    applyEvent(state, { type: "opportunity_found", routeKey: "0xtest", profitWei: 100n });
    applyEvent(state, { type: "execution_result", routeKey: "0xtest", success: true });

    r.render(layout, state);
    const output = stdout.getBuffer();
    expect(output).toContain("1");
  });

  it("renders log entries", () => {
    const stdout = createMockStdout();
    const r = new Renderer(stdout);
    const layout = computeLayout(80, 24);
    const state = createInitialState();
    applyEvent(state, { type: "error", component: "Test", message: "hello world" });

    r.render(layout, state);
    const output = stdout.getBuffer();
    expect(output).toContain("hello world");
  });
});
