import { logger } from "../utils/logger.ts";
import type { DecodeResult } from "../protocols/factories.ts";
import { normalizeEvmAddress } from "../utils/pool_record.ts";
import { normalizeHyperSyncLogInteger } from "../hypersync/logs.ts";

const discoveryLogger = logger.child({ component: "discovery" });

export type DiscoveryRawLog = {
  address?: unknown;
  blockNumber: number | string;
  transactionHash?: string;
  transactionIndex?: number | string | null;
  logIndex?: number | string | null;
};

export type DiscoveredPoolCandidate = {
  extracted: DecodeResult;
  rawLog: DiscoveryRawLog;
};

type DiscoveryBatchEntry = {
  row: Record<string, unknown>;
  order: {
    block: number;
    transactionIndex: number;
    logIndex: number;
    sequence: number;
  };
};

function normalizeDiscoveryMetadata(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function compareDiscoveryOrder(a: DiscoveryBatchEntry["order"], b: DiscoveryBatchEntry["order"]) {
  return (
    a.block - b.block ||
    a.transactionIndex - b.transactionIndex ||
    a.logIndex - b.logIndex ||
    a.sequence - b.sequence
  );
}

export function buildDiscoveredPoolBatch(key: string, extractedPools: DiscoveredPoolCandidate[]) {
  let skipped = 0;
  const latestByPoolAddress = new Map<string, DiscoveryBatchEntry>();

  for (let sequence = 0; sequence < extractedPools.length; sequence++) {
    const { extracted, rawLog } = extractedPools[sequence];
    const poolAddress = normalizeEvmAddress(extracted.pool_address);
    const tokens = [
      ...new Set(
        (extracted.tokens ?? [])
          .map((token) => normalizeEvmAddress(token))
          .filter((token): token is string => token != null),
      ),
    ];
    const block = normalizeHyperSyncLogInteger(rawLog.blockNumber);

    if (!poolAddress || tokens.length < 2 || block == null) {
      skipped++;
      continue;
    }

    const entry: DiscoveryBatchEntry = {
      row: {
        protocol: key,
        block,
        tx: typeof rawLog.transactionHash === "string" ? rawLog.transactionHash.trim() || undefined : undefined,
        pool_address: poolAddress,
        tokens,
        metadata: normalizeDiscoveryMetadata(extracted.metadata),
        status: "active",
      },
      order: {
        block,
        transactionIndex: normalizeHyperSyncLogInteger(rawLog.transactionIndex) ?? -1,
        logIndex: normalizeHyperSyncLogInteger(rawLog.logIndex) ?? -1,
        sequence,
      },
    };

    const prior = latestByPoolAddress.get(poolAddress);
    if (!prior || compareDiscoveryOrder(entry.order, prior.order) >= 0) {
      latestByPoolAddress.set(poolAddress, entry);
    }
  }

  if (skipped > 0) {
    console.log(`  Skipped ${skipped} malformed or uninitialized pool candidate(s).`);
  }

  const deduped = [...latestByPoolAddress.values()].map((entry) => entry.row);
  const initializedPoolCount = extractedPools.length - skipped;
  if (deduped.length !== initializedPoolCount) {
    discoveryLogger.info(
      {
        protocol: key,
        initializedPools: initializedPoolCount,
        dedupedPools: deduped.length,
      },
      "[discovery] Deduplicated discovered pool batch",
    );
  }
  return deduped;
}
