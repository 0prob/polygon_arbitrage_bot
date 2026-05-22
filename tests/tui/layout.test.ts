import { describe, it, expect } from "vitest";
import { computeLayout } from "../../src/tui/layout.ts";

describe("computeLayout", () => {
  it("assigns status bar to row 0", () => {
    const layout = computeLayout(80, 24);
    expect(layout.statusBar.y).toBe(0);
    expect(layout.statusBar.height).toBe(1);
  });

  it("assigns keymap bar to last row", () => {
    const layout = computeLayout(80, 24);
    expect(layout.keymapBar.y).toBe(23);
    expect(layout.keymapBar.height).toBe(1);
  });

  it("splits middle section into two columns", () => {
    const layout = computeLayout(80, 24);
    expect(layout.metricsPanel.y).toBe(1);
    expect(layout.systemPanel.y).toBe(1);
    expect(layout.metricsPanel.x).toBe(0);
    expect(layout.systemPanel.x).toBeGreaterThan(0);
    expect(layout.metricsPanel.width + layout.systemPanel.width).toBe(80);
  });

  it("places log panel below metrics/system", () => {
    const layout = computeLayout(80, 24);
    expect(layout.logPanel.y).toBeGreaterThan(layout.metricsPanel.y + layout.metricsPanel.height - 1);
  });

  it("handles small terminal gracefully", () => {
    const layout = computeLayout(40, 10);
    expect(layout.statusBar.width).toBe(40);
    expect(layout.keymapBar.width).toBe(40);
    expect(layout.metricsPanel.width + layout.systemPanel.width).toBe(40);
  });
});
