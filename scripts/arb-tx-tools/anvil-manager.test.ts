import { describe, it, expect, beforeEach } from "vitest";
import { AnvilManager } from "./anvil-manager.ts";

describe("AnvilManager", () => {
  let manager: AnvilManager;

  beforeEach(() => {
    manager = new AnvilManager();
  });

  it("starts as not running", () => {
    expect(manager.isRunning()).toBe(false);
  });

  it("getInfo returns null when not running", () => {
    expect(manager.getInfo()).toBeNull();
  });

  it("startFork throws when POLYGON_RPC_URL is missing", async () => {
    const saved = process.env.POLYGON_RPC_URL;
    delete process.env.POLYGON_RPC_URL;
    await expect(manager.startFork()).rejects.toThrow("POLYGON_RPC_URL");
    process.env.POLYGON_RPC_URL = saved;
  });

  it("stopFork is a no-op when not running", async () => {
    const result = await manager.stopFork();
    expect(result).toEqual({ stopped: false });
  });
});
