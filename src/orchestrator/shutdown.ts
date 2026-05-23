import type { RuntimeContext } from "./boot.ts";
import { writeStatusFile, type StatusPayload } from "./status_writer.ts";

async function stopService<T>(label: string, service: { stop: () => T }, logger: RuntimeContext["logger"]): Promise<void> {
  try {
    const result = service.stop();
    if (result instanceof Promise) await result;
  } catch (err) {
    logger.error({ err, service: label }, "Service stop failed");
  }
}

export async function shutdownApplication(ctx: RuntimeContext): Promise<void> {
  ctx.isRunning = false;

  ctx.logger.info({}, "Shutting down services");

  await stopService("execution", ctx.executionService, ctx.logger);
  await stopService("mempool", ctx.mempoolService, ctx.logger);

  const finalPayload: StatusPayload = {
    status: "stopped",
    uptimeSec: Math.floor((Date.now() - ctx.metrics.startTime) / 1000),
    cycle: ctx.metrics.cycles,
    lastCycleMs: ctx.metrics.lastCycleDurationMs,
    errors: ctx.metrics.totalErrors,
    lastError: ctx.metrics.lastErrorTime ? new Date(ctx.metrics.lastErrorTime).toISOString() : null,
    lastErrorMsg: ctx.metrics.lastErrorMessage,
    opportunities: ctx.metrics.opportunitiesFound,
    executed: ctx.metrics.executionsAttempted,
    succeeded: ctx.metrics.executionsSuccessful,
    failed: ctx.metrics.executionsFailed,
    gasPriceGwei: 0,
    pools: 0,
    cyclesPerMin: 0,
    peakCpm: ctx.metrics.peakCyclesPerMinute,
    timestamp: new Date().toISOString(),
  };
  await writeStatusFile(ctx.config.paths.dataDir, finalPayload).catch(() => {});

  ctx.logger.info({}, "Shutdown complete");
}
