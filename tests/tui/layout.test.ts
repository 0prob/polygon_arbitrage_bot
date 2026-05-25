import { describe, it, expect } from "vitest";
import { computeLayout } from "../../src/tui/layout.ts";

describe("computeLayout", () => {
  it("assigns header to row 0", () => {
    const layout = computeLayout(80, 24);
    expect(layout.header.y).toBe(0);
    expect(layout.header.height).toBe(1);
  });

  it("assigns keymap bar to last row", () => {
    const layout = computeLayout(80, 24);
    expect(layout.keymap.y).toBe(23);
    expect(layout.keymap.height).toBe(1);
  });

  it("splits middle section correctly", () => {
    const layout = computeLayout(80, 24);
    expect(layout.pipeline.y).toBe(1);
    expect(layout.sidebar.y).toBe(1);
    expect(layout.pipeline.x).toBe(0);
    expect(layout.sidebar.x).toBeGreaterThan(0);
    expect(layout.pipeline.width + layout.sidebar.width).toBe(80);
  });

  it("places log panel below mainTable", () => {
    const layout = computeLayout(80, 24);
    expect(layout.footerLog.y).toBeGreaterThan(layout.mainTable.y + layout.mainTable.height - 1);
  });

  it("handles small terminal gracefully", () => {
    const layout = computeLayout(40, 10);
    // Note: computeLayout now maxes safeCols to 80 and safeRows to 20
    expect(layout.header.width).toBe(80);
    expect(layout.keymap.width).toBe(80);
    expect(layout.pipeline.width + layout.sidebar.width).toBe(80);
  });
});
