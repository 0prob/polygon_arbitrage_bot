/**
 * src/routing/worker.ts — One-shot worker wrapper
 *
 * Kept for compatibility with any older call sites that still spawn this file
 * directly instead of using the persistent worker pool.
 */

import { parentPort, workerData } from "worker_threads";
import { evaluatePaths } from "./simulator.ts";
import { rehydrateStateData } from "../db/registry_codec.ts";
import { normalizeEvmAddress } from "../utils/pool_record.ts";
import { errorMessage } from "../utils/errors.ts";

if (!parentPort) {
  console.warn("[worker] worker.ts imported outside a Worker thread — no-op");
  process.exit(0);
}

try {
  const { paths, stateObj, testAmount, options } = workerData || {};
  const incoming = stateObj instanceof Map ? stateObj : new Map(Object.entries(stateObj || {}));
  const stateCache = new Map();
  for (const [poolAddress, state] of incoming) {
    const normalizedPool = normalizeEvmAddress(poolAddress);
    if (!normalizedPool) continue;
    rehydrateStateData(state.protocol, state);
    stateCache.set(normalizedPool, state);
  }

  const profitable = evaluatePaths(paths || [], stateCache, BigInt(testAmount ?? 0), options || {});

  parentPort.postMessage({ profitable });
} catch (err: unknown) {
  parentPort.postMessage({ error: errorMessage(err) });
}
