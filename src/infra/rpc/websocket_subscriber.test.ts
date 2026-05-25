import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebSocketSubscriber } from "./websocket_subscriber.ts";

describe("WebSocketSubscriber", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts in stopped state", () => {
    const ws = new WebSocketSubscriber({ url: "ws://localhost:8546" });
    expect(ws.isRunning()).toBe(false);
  });

  it("can start and stop", async () => {
    const ws = new WebSocketSubscriber({ url: "ws://localhost:8546" });
    await ws.start();
    expect(ws.isRunning()).toBe(true);
    ws.stop();
    expect(ws.isRunning()).toBe(false);
  });

  it("registers and removes event handlers", () => {
    const ws = new WebSocketSubscriber({ url: "ws://localhost:8546" });
    const handler = vi.fn();
    ws.onEvent(handler);
    ws.removeHandler(handler);
  });
});
