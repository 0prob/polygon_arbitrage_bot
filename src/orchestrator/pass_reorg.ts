import type { RuntimeContext } from "./boot.ts";
import type { PassLoopState } from "./pass_state.ts";
import { publishHfSnapshot } from "./hf_snapshot.ts";
import { clearPoolFetchTracking } from "../pipeline/fetcher.ts";
import { debugBreak, DebugSites } from "../infra/debug/session.ts";

async function fetchChainTip(ctx: RuntimeContext): Promise<{ number: number; hash: string; parentHash?: string } | null> {
  try {
    // HyperRPC first (cached blockNumber) — reserve HyperSync quota for the indexer.
    if (ctx.hyperRpc) {
      const block = await ctx.hyperRpc.getBlockByNumber("latest");
      if (block?.number && block?.hash) {
        return {
          number: parseInt(String(block.number), 16),
          hash: String(block.hash),
          parentHash: block.parentHash ? String(block.parentHash) : undefined,
        };
      }
    }
    const block = await ctx.publicClient.getBlock({ blockTag: "latest" });
    if (block.number != null && block.hash) {
      return {
        number: Number(block.number),
        hash: block.hash,
        parentHash: block.parentHash,
      };
    }
    if (ctx.hyperSync) {
      const hsBlock = await ctx.hyperSync.getBlockByNumber("latest");
      if (hsBlock?.number != null && hsBlock?.hash) {
        return {
          number: Number(hsBlock.number),
          hash: String(hsBlock.hash),
          parentHash: hsBlock.parentHash ? String(hsBlock.parentHash) : undefined,
        };
      }
    }
  } catch (err) {
    ctx.logger.debug?.({ err }, "Chain tip fetch failed (best effort)");
  }
  return null;
}

/** Drop cached routes and force LF re-enumeration after a chain reorg. */
export function invalidateRoutingOnReorg(state: PassLoopState): void {
  state.cachedCycles = [];
  state.cachedRoutingGraph = null;
  state.graphUpdater?.resetRebuildCounter();
  state.lastEnumerationTime = 0;
  state.lastPoolsFingerprint = "";
  state.lastRefreshTime = 0;
  state.hfSimOffset = 0;
  state.hfCycleFilterCache = undefined;
  state.lastEnumStateCacheSize = 0;
  state.ratesNeedFullRefresh = true;
  state.oracleRateCache = undefined;
  publishHfSnapshot(state);
}

/** Clear routing + on-chain state after a confirmed or locally detected reorg. */
export function applyReorgInvalidation(ctx: RuntimeContext, state: PassLoopState, reason: string): void {
  debugBreak(DebugSites.REORG_DETECTED, { reason });
  invalidateRoutingOnReorg(state);
  ctx.stateCache.clear();
  clearPoolFetchTracking();
  ctx.logger.warn({ reason }, "Reorg detected — forcing state refresh");
}

export async function runReorgCheck(
  ctx: RuntimeContext,
  lastReorgCheck: number,
  lfInterval: number,
): Promise<{ lastReorgCheck: number; shouldForceRefresh: boolean }> {
  const now = Date.now();
  if (ctx.reorgDetector && ctx.publicClient && now - lastReorgCheck > lfInterval) {
    const detector = ctx.reorgDetector;
    try {
      const chainTip = await fetchChainTip(ctx);
      const reorged = await detector.checkReorg(
        chainTip ? { number: chainTip.number, hash: chainTip.hash } : undefined,
      );
      let shouldForceRefresh = false;
      if (reorged.size > 0) {
        debugBreak(DebugSites.REORG_DETECTED, { blocks: [...reorged].join(",") });
        ctx.logger.warn({ reorgedBlocks: [...reorged].join(",") }, "Reorg detected — forcing state refresh");
        detector.clearReorged();
        shouldForceRefresh = true;
        ctx.stateCache.clear();
        clearPoolFetchTracking();
      }

      if (chainTip) {
        await detector.trackBlock(chainTip.number, chainTip.hash, chainTip.parentHash);
      }

      return { lastReorgCheck: now, shouldForceRefresh };
    } catch (err) {
      ctx.logger.debug?.({ err }, "Reorg check failed (best effort)");
    }
  }
  return { lastReorgCheck, shouldForceRefresh: false };
}
