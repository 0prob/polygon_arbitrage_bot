import { describe, it, expect, vi } from "vitest";
import { ServiceRegistry } from "./service_registry.ts";

describe("ServiceRegistry", () => {
  it("registers and resolves a service", () => {
    const reg = new ServiceRegistry();
    reg.register("foo", { bar: 1 });
    expect(reg.resolve<{ bar: number }>("foo").bar).toBe(1);
  });

  it("returns has() correctly", () => {
    const reg = new ServiceRegistry();
    expect(reg.has("foo")).toBe(false);
    reg.register("foo", {});
    expect(reg.has("foo")).toBe(true);
  });

  it("throws on missing service", () => {
    const reg = new ServiceRegistry();
    expect(() => reg.resolve("nonexistent")).toThrow("Service not found: nonexistent");
  });

  it("overwrites existing registration", () => {
    const reg = new ServiceRegistry();
    reg.register("x", 1);
    reg.register("x", 2);
    expect(reg.resolve<number>("x")).toBe(2);
  });

  it("calls lifecycle prepareAll", async () => {
    const reg = new ServiceRegistry();
    const prepare = vi.fn().mockResolvedValue(undefined);
    reg.register("a", {}, { prepare, start: async () => {}, stop: async () => {} });
    reg.register("b", {});
    await reg.prepareAll();
    expect(prepare).toHaveBeenCalledOnce();
  });

  it("calls lifecycle startAll", async () => {
    const reg = new ServiceRegistry();
    const start = vi.fn().mockResolvedValue(undefined);
    reg.register("x", {}, { prepare: async () => {}, start, stop: async () => {} });
    await reg.startAll();
    expect(start).toHaveBeenCalledOnce();
  });

  it("calls lifecycle stopAll in reverse order, best-effort", async () => {
    const reg = new ServiceRegistry();
    const order: string[] = [];
    const mkLifecycle = (name: string) => ({
      prepare: async () => {},
      start: async () => {},
      stop: async () => { order.push(name); },
    });
    reg.register("a", {}, mkLifecycle("a"));
    reg.register("b", {}, mkLifecycle("b"));
    await reg.stopAll();
    expect(order).toEqual(["b", "a"]);
  });

  it("continues stopAll even if one throws", async () => {
    const reg = new ServiceRegistry();
    const order: string[] = [];
    reg.register("a", {}, { prepare: async () => {}, start: async () => {}, stop: async () => { order.push("a"); throw new Error("oops"); } });
    reg.register("b", {}, { prepare: async () => {}, start: async () => {}, stop: async () => { order.push("b"); } });
    await reg.stopAll();
    expect(order).toEqual(["b", "a"]);
  });
});
