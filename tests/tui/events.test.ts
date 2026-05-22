import { describe, it, expect, vi } from "vitest";
import { EventBus, type ArbEvent } from "../../src/tui/events.ts";

describe("EventBus", () => {
  it("delivers events to subscribed handlers", () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on(handler);

    const event: ArbEvent = { type: "heartbeat", elapsedMs: 100 };
    bus.emit(event);

    expect(handler).toHaveBeenCalledWith(event);
  });

  it("allows unsubscribe via returned function", () => {
    const bus = new EventBus();
    const handler = vi.fn();
    const off = bus.on(handler);

    off();
    bus.emit({ type: "heartbeat", elapsedMs: 50 });

    expect(handler).not.toHaveBeenCalled();
  });

  it("delivers to multiple handlers", () => {
    const bus = new EventBus();
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.on(h1);
    bus.on(h2);

    bus.emit({ type: "shutdown" });

    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it("survives handler throwing without affecting other handlers", () => {
    const bus = new EventBus();
    const throwing = vi.fn().mockImplementation(() => {
      throw new Error("oops");
    });
    const good = vi.fn();
    bus.on(throwing);
    bus.on(good);

    expect(() => bus.emit({ type: "heartbeat", elapsedMs: 0 })).not.toThrow();
    expect(good).toHaveBeenCalled();
  });
});
