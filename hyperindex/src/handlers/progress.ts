import { indexer } from "envio";
import { getProgressOnBlockStride } from "../utils/pacing";

/**
 * Block handler that maintains the IndexerProgress entity.
 *
 * This uses the official "Different Historical and Realtime Intervals" pattern:
 * https://docs.envio.dev/docs/HyperIndex/block-handlers#different-historical-and-realtime-intervals
 *
 * We register the *exact same handler function* twice, but with different `name`
 * values and different `where` filters (one with `_lte` + coarse stride for history,
 * one with `_gte` for the realtime tail). This gives fast historical backfills
 * while still providing reasonably fresh progress during live operation.
 *
 * Also demonstrates:
 * - Preload optimization guard (`context.isPreload`)
 * - Self-registration (no config.yaml entry required)
 * - Multi-chain ready `where` structure
 */

// -----------------------------------------------------------------------------
// Configuration (override via environment variables)
// -----------------------------------------------------------------------------
const getEffectiveChainStart = (): number => {
  const v = process.env.POLYGON_START_BLOCK;
  const n = v ? Number(v) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const getRealtimeStart = (chainId: number): number | undefined => {
  if (chainId !== 137) return undefined;

  const override = process.env.INDEXER_PROGRESS_REALTIME_START;
  if (override) {
    const n = Number(override);
    return Number.isFinite(n) ? n : undefined;
  }

  const chainStart = getEffectiveChainStart();
  if (chainStart >= 80_000_000) {
    // Live-debug / high-start mode (e.g. POLYGON_START_BLOCK=86M).
    // Start progress tracking from (or very near) the chain start so the
    // onBlock where range never goes below what the chain is configured for.
    return chainStart;
  }

  // Normal / historical-friendly default
  return 65_000_000;
};

const HISTORICAL_EVERY = getProgressOnBlockStride(Number(process.env.INDEXER_PROGRESS_HISTORICAL_EVERY ?? 2000));
const REALTIME_EVERY   = getProgressOnBlockStride(Number(process.env.INDEXER_PROGRESS_REALTIME_EVERY   ?? 200));

// -----------------------------------------------------------------------------
// The single handler implementation (registered twice below)
// -----------------------------------------------------------------------------
const updateIndexerProgress = async ({ block, context }: any) => {
  if (context.isPreload) return;

  const chainId = context.chain.id;

  context.IndexerProgress.set({
    id: String(chainId),
    chainId,
    lastProcessedBlock: block.number,
    updatedAtBlock: block.number,
  });
};

// -----------------------------------------------------------------------------
// Historical registration (coarse stride, everything before the cutoff)
// Only register if there is actually a historical range to cover for this chain.
// This avoids the noisy "indexer.onBlock matched 0 chains" warning in high-start
// live-debug runs (e.g. POLYGON_START_BLOCK=86M).
// -----------------------------------------------------------------------------
const _chainStartForReg = getEffectiveChainStart();
const _realtimeForReg = getRealtimeStart(137);
const _shouldRegisterHistorical =
  _realtimeForReg != null && _realtimeForReg - 1 >= _chainStartForReg;

if (_shouldRegisterHistorical) {
  indexer.onBlock(
    {
      name: "IndexerProgressHistorical",
      where: ({ chain }) => {
        const start = getRealtimeStart(chain.id);
        if (!start) return false;

        const chainStart = getEffectiveChainStart();
        const histEnd = start - 1;
        if (histEnd < chainStart) return false;

        return {
          block: {
            number: {
              _lte: histEnd,
              _every: HISTORICAL_EVERY,
            },
          },
        };
      },
    },
    updateIndexerProgress
  );
}

// -----------------------------------------------------------------------------
// Realtime registration (finer stride, from the cutoff forward)
// -----------------------------------------------------------------------------
indexer.onBlock(
  {
    name: "IndexerProgressRealtime",
    where: ({ chain }) => {
      const start = getRealtimeStart(chain.id);
      if (!start) return false;

      const chainStart = getEffectiveChainStart();
      // Never ask for blocks before what the chain itself is configured to start at.
      const effectiveStart = Math.max(start, chainStart);

      return {
        block: {
          number: {
            _gte: effectiveStart,
            _every: REALTIME_EVERY,
          },
        },
      };
    },
  },
  updateIndexerProgress
);
