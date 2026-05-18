import type { RuntimeContext } from "./boot.ts";

export async function shutdownApplication(ctx: RuntimeContext): Promise<void> {
  ctx.isRunning = false;

  ctx.logger.info({}, "Shutting down services");

  ctx.executionService.stop();
  ctx.mempoolService.stop();
  await ctx.watcherService.stop();
  ctx.hydrationService.stop();
  ctx.discoveryService.stop();

  ctx.db.close();

  ctx.logger.info({}, "Shutdown complete");
}
