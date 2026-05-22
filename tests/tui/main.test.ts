import { describe, it, expect } from "vitest";
import { createTui } from "../../src/tui/main.ts";

describe("createTui", () => {
  it("returns a TuiInstance with bus", () => {
    const tui = createTui();
    expect(tui.bus).toBeDefined();
    expect(typeof tui.start).toBe("function");
    expect(typeof tui.stop).toBe("function");
  });

  it("start and stop are safe to call multiple times", () => {
    const tui = createTui();
    expect(() => { tui.start(); tui.stop(); tui.start(); tui.stop(); }).not.toThrow();
  });
});
