import type { RuntimeContext } from "./boot.ts";

export async function runReorgCheck(
  ctx: RuntimeContext,
  lastReorgCheck: number,
  lfInterval: number,
): Promise<{ lastReorgCheck: number; shouldForceRefresh: boolean }> {
  const now = Date.now();
  if (ctx.reorgDetector && ctx.publicClient && now - lastReorgCheck > lfInterval) {
    const detector = ctx.reorgDetector;
    try {
      const reorged = await detector.checkReorg();
      let shouldForceRefresh = false;
      if (reorged.size > 0) {
        ctx.logger.warn({ reorgedBlocks: [...reorged].join(",") }, "Reorg detected — forcing state refresh");
        detector.clearReorged();
        shouldForceRefresh = true;
      }

      const latest = ctx.hyperSync
        ? await ctx.hyperSync.getBlockByNumber("latest")
        : ctx.hyperRpc
          ? await ctx.hyperRpc.getBlockByNumber("latest")
          : await ctx.publicClient.getBlock({ blockTag: "latest" });
      if (latest?.number && latest?.hash) {
        await detector.trackBlock(Number(latest.number), latest.hash as `0x${string}`);
      }

      return { lastReorgCheck: now, shouldForceRefresh };
    } catch (err) {
      ctx.logger.debug?.({ err }, "Reorg check failed (best effort)");
    }
  }
  return { lastReorgCheck, shouldForceRefresh: false };
}
