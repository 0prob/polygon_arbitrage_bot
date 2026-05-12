export type DiscoveryResult = {
  totalDiscovered: number;
  activePools: number;
};

import { errorMessage } from "../utils/errors.ts";

type DiscoveryDeps = {
  discoverPools: () => Promise<DiscoveryResult>;
  log: (msg: string, level?: "fatal" | "error" | "warn" | "info" | "debug" | "trace", meta?: unknown) => void;
  discoveryIntervalMs: number;
};

export function createDiscoveryCoordinator(deps: DiscoveryDeps) {
  let lastDiscoveryMs = 0;
  let discoveryInFlight = false;

  async function maybeRunDiscovery(force = false): Promise<DiscoveryResult | null> {
    const now = Date.now();
    if (discoveryInFlight) return null;
    if (!force && now - lastDiscoveryMs < deps.discoveryIntervalMs) return null;

    discoveryInFlight = true;

    try {
      deps.log("Background discovery starting...", "info", {
        event: "discovery_start",
        forced: force,
      });
      const result = await deps.discoverPools();
      lastDiscoveryMs = Date.now();
      deps.log(`Background discovery complete: ${result.totalDiscovered} new pools`, "info", {
        event: "discovery_complete",
        forced: force,
        totalDiscovered: result.totalDiscovered,
        activePools: result.activePools,
      });
      return result;
    } catch (err: unknown) {
      deps.log(`Background discovery failed: ${errorMessage(err)}`, "warn", {
        event: "discovery_failed",
        forced: force,
        err,
      });
      return null;
    } finally {
      discoveryInFlight = false;
    }
  }

  async function runInitialDiscovery() {
    deps.log("Initial pool discovery...");
    try {
      const result = await deps.discoverPools();
      lastDiscoveryMs = Date.now();
      deps.log(`Discovery: ${result.totalDiscovered} new, ${result.activePools} active`);
      return result;
    } catch (err: unknown) {
      deps.log(`Initial discovery failed: ${errorMessage(err)} — using cached state`, "warn");
      return null;
    }
  }

  return {
    maybeRunDiscovery,
    runInitialDiscovery,
  };
}
