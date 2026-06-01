import { indexer } from "envio";

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
const getRealtimeStart = (chainId: number): number | undefined => {
  if (chainId === 137) {
    // Polygon — the chain this indexer primarily runs on.
    // Default chosen to be after many major DEX deployments but still allows
    // a meaningful historical period when doing fresh syncs.
    return Number(process.env.INDEXER_PROGRESS_REALTIME_START ?? 65_000_000);
  }
  // Extend here for additional chains in the future
  return undefined;
};

const HISTORICAL_EVERY = Number(process.env.INDEXER_PROGRESS_HISTORICAL_EVERY ?? 2000);
const REALTIME_EVERY   = Number(process.env.INDEXER_PROGRESS_REALTIME_EVERY   ?? 200);

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
// -----------------------------------------------------------------------------
indexer.onBlock(
  {
    name: "IndexerProgressHistorical",
    where: ({ chain }) => {
      const start = getRealtimeStart(chain.id);
      if (!start) return false;

      return {
        block: {
          number: {
            _lte: start - 1,
            _every: HISTORICAL_EVERY,
          },
        },
      };
    },
  },
  updateIndexerProgress
);

// -----------------------------------------------------------------------------
// Realtime registration (finer stride, from the cutoff forward)
// -----------------------------------------------------------------------------
indexer.onBlock(
  {
    name: "IndexerProgressRealtime",
    where: ({ chain }) => {
      const start = getRealtimeStart(chain.id);
      if (!start) return false;

      return {
        block: {
          number: {
            _gte: start,
            _every: REALTIME_EVERY,
          },
        },
      };
    },
  },
  updateIndexerProgress
);
