import type { RuntimeContext } from "./boot.ts";

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

  ctx.logger.info({}, "Shutdown complete");
}
