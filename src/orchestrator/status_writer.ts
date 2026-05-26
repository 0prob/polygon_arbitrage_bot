import { writeFile, rename } from "fs/promises";
import { join } from "path";
import type { Metrics } from "../core/types/metrics.ts";

export interface StatusPayload {
  status: "running" | "stopped" | "error";
  uptimeSec: number;
  cycle: number;
  lastCycleMs: number;
  errors: number;
  lastError: string | null;
  lastErrorMsg: string | null;
  opportunities: number;
  executed: number;
  succeeded: number;
  failed: number;
  reverts: number;
  trackedRoutes: number;
  gasPriceGwei: number;
  pools: number;
  cyclesPerMin: number;
  peakCpm: number;
  timestamp: string;
}

export function formatGwei(gasPrice: bigint | undefined): number {
  if (!gasPrice) return 0;
  return Number(gasPrice) / 1e9;
}

export function buildStatusPayload(metrics: Metrics, gasPrice: bigint | undefined, poolCount: number): StatusPayload {
  const uptimeSec = Math.floor((Date.now() - metrics.startTime) / 1000);
  return {
    status: "running",
    uptimeSec,
    cycle: metrics.cycles,
    lastCycleMs: metrics.lastCycleDurationMs,
    errors: metrics.totalErrors,
    lastError: metrics.lastErrorTime ? new Date(metrics.lastErrorTime).toISOString() : null,
    lastErrorMsg: metrics.lastErrorMessage,
    opportunities: metrics.opportunitiesFound,
    executed: metrics.executionsAttempted,
    succeeded: metrics.executionsSuccessful,
    failed: metrics.executionsFailed,
    reverts: metrics.executionReverts,
    trackedRoutes: metrics.trackedRoutes,
    gasPriceGwei: formatGwei(gasPrice),
    pools: poolCount,
    cyclesPerMin: metrics.currentCyclesPerMinute,
    peakCpm: metrics.peakCyclesPerMinute,
    timestamp: new Date().toISOString(),
  };
}

export async function writeStatusFile(dataDir: string, payload: StatusPayload): Promise<void> {
  const tmp = join(dataDir, "status.json.tmp");
  const finalPath = join(dataDir, "status.json");
  await writeFile(tmp, JSON.stringify(payload, null, 2) + "\n");
  await rename(tmp, finalPath);
}
