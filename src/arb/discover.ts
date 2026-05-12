
/**
 * src/discovery/discover.js — Core discovery engine
 *
 * Orchestrates per-protocol pool discovery:
 *   1. Resume from checkpoint (or start from genesis)
 *   2. Build HyperSync query with minimal field selection + JoinNothing
 *   3. Paginated fetch via fetchAllLogs()
 *   4. ABI decode all logs
 *   5. Batch on-chain enrichment with concurrency throttling
 *   6. Batch insert into registry + update checkpoint from nextBlock
 */

import { errorMessage } from "../utils/errors.ts";
import { client, Decoder, LogField } from "../hypersync/client.ts";
import { fetchAllLogs } from "../hypersync/paginate.ts";
import { topic0sForSignatures } from "../hypersync/topics.ts";
import {
  buildHyperSyncLogQuery,
  DEFAULT_HYPERSYNC_LOG_FIELDS,
} from "../hypersync/query_policy.ts";
import { RegistryService } from "../db/registry.ts";
import { PROTOCOLS, CURVE_POOL_REMOVED } from "../protocols/index.ts";
import { detectReorg } from "../state/reorg_detect.ts";
import { throttledMap } from "../state/enrichment/rpc.ts";
import { hydrateNewTokens } from "../state/enrichment/token_hydrator.ts";
import {
  DB_PATH,
  ENVIO_API_TOKEN,
  ENABLE_V3_PROTOCOLS,
  HYPERSYNC_URL,
  ENRICH_CONCURRENCY,
  DISCOVERY_PROTOCOL_CONCURRENCY,
} from "../config/index.ts";
import { ALL_V3_PROTOCOLS, normalizeProtocolKey } from "../protocols/classification.ts";
import { logger } from "../utils/logger.ts";
import { buildDiscoveredPoolBatch, type DiscoveredPoolCandidate, type DiscoveryRawLog } from "./discovery_helpers.ts";
import {
  decodedIndexedString,
  type DecodeResult,
  type ProtocolDefinition,
  type ProtocolDiscoveryResult,
} from "../protocols/factories.ts";
import type { HyperSyncLogQuery } from "../hypersync/query_policy.ts";

const DEFAULT_DISCOVERY_START_BLOCK = 0;

type DiscoveryProtocol = ProtocolDefinition & {
  signatures?: string[];
  decode: NonNullable<ProtocolDefinition["decode"]>;
};

type ProtocolRunResult = {
  key: string;
  protocol: DiscoveryProtocol;
  result: ProtocolDiscoveryResult | null;
  error: unknown | null;
};

export type ProtocolCoverageEntry = {
  protocol: string;
  name: string;
  activePools: number;
  totalPools: number;
  checkpointBlock: number | null;
  discovered: number;
  error: string | null;
};

export type ProtocolFamilyCoverageEntry = {
  family: string;
  name: string;
  protocols: number;
  activePools: number;
  totalPools: number;
  discovered: number;
  minCheckpointBlock: number | null;
  maxCheckpointBlock: number | null;
  errors: string[];
  protocolKeys: string[];
};

type RollbackSummary = {
  poolsRemoved?: unknown;
  statesRemoved?: unknown;
};

const discoveryQuerySpecCache = new Map<string, {
  topic0s: string[];
  decoder: InstanceType<typeof Decoder>;
}>();
const discoveryLogger = logger.child({ component: "discovery" });


function errorStack(error: unknown) {
  return error instanceof Error ? error.stack : undefined;
}

function rollbackSummary(value: unknown): RollbackSummary {
  return value && typeof value === "object" ? value as RollbackSummary : {};
}

function discoveryQueryToBlock(chainHeight: number | string | null | undefined) {
  if (chainHeight == null) {
    return undefined;
  }

  const numericChainHeight = Number(chainHeight);
  if (!Number.isFinite(numericChainHeight) || numericChainHeight < 0) {
    return undefined;
  }
  return numericChainHeight + 1;
}

function discoveryCheckpointFromNextBlock(nextBlock: number | null, fallbackFromBlock: number) {
  const numericNextBlock = Number(nextBlock);
  if (Number.isFinite(numericNextBlock) && numericNextBlock > 0) {
    return numericNextBlock - 1;
  }
  return Math.max(0, fallbackFromBlock - 1);
}

function discoverySignatures(protocol: Pick<ProtocolDefinition, "signature"> & { signatures?: string[] }) {
  if (protocol.signatures?.length) return protocol.signatures;
  return protocol.signature ? [protocol.signature] : [];
}

const PROTOCOL_FAMILY_LABELS = new Map<string, string>([
  ["BALANCER", "Balancer"],
  ["COMETHSWAP", "ComethSwap"],
  ["CURVE", "Curve"],
  ["DFYN", "Dfyn"],
  ["DODO", "DODO"],
  ["KYBERSWAP", "KyberSwap"],
  ["QUICKSWAP", "QuickSwap"],
  ["SUSHISWAP", "SushiSwap"],
  ["UNISWAP", "Uniswap"],
  ["WOOFI", "WOOFi"],
]);

function protocolCoverageFamily(protocol: string) {
  const normalized = protocol.trim().toUpperCase();
  if (!normalized) return "UNKNOWN";
  return normalized.split("_")[0] || normalized;
}

function protocolCoverageFamilyName(family: string) {
  const label = PROTOCOL_FAMILY_LABELS.get(family);
  if (label) return label;
  return family
    .split("_")
    .filter((part) => part.length > 0)
    .map((part) => part[0] + part.slice(1).toLowerCase())
    .join(" ");
}

function numericCheckpointBlock(value: unknown) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
}

export function summarizeProtocolCoverageByFamily(protocolCoverage: ProtocolCoverageEntry[]): ProtocolFamilyCoverageEntry[] {
  const summaries = new Map<string, ProtocolFamilyCoverageEntry>();

  for (const entry of protocolCoverage) {
    const family = protocolCoverageFamily(entry.protocol);
    let summary = summaries.get(family);
    if (!summary) {
      summary = {
        family,
        name: protocolCoverageFamilyName(family),
        protocols: 0,
        activePools: 0,
        totalPools: 0,
        discovered: 0,
        minCheckpointBlock: null,
        maxCheckpointBlock: null,
        errors: [],
        protocolKeys: [],
      };
      summaries.set(family, summary);
    }

    summary.protocols += 1;
    summary.activePools += entry.activePools;
    summary.totalPools += entry.totalPools;
    summary.discovered += entry.discovered;
    summary.protocolKeys.push(entry.protocol);

    if (entry.checkpointBlock != null) {
      summary.minCheckpointBlock =
        summary.minCheckpointBlock == null
          ? entry.checkpointBlock
          : Math.min(summary.minCheckpointBlock, entry.checkpointBlock);
      summary.maxCheckpointBlock =
        summary.maxCheckpointBlock == null
          ? entry.checkpointBlock
          : Math.max(summary.maxCheckpointBlock, entry.checkpointBlock);
    }
    if (entry.error) {
      summary.errors.push(`${entry.protocol}: ${entry.error}`);
    }
  }

  return [...summaries.values()].sort(
    (a, b) => b.activePools - a.activePools || a.family.localeCompare(b.family)
  );
}

export function protocolDiscoveryStartBlock(protocol: Pick<ProtocolDefinition, "startBlock"> | null | undefined) {
  const startBlock = Number(protocol?.startBlock);
  if (Number.isSafeInteger(startBlock) && startBlock >= 0) {
    return startBlock;
  }
  return DEFAULT_DISCOVERY_START_BLOCK;
}

export function resolveDiscoveryFromBlock(
  protocol: Pick<ProtocolDefinition, "startBlock"> | null | undefined,
  checkpointLastBlock: unknown,
  existingPoolCount: number,
) {
  const startBlock = protocolDiscoveryStartBlock(protocol);
  const existingCheckpointBlock = Number(checkpointLastBlock);
  const hasCheckpoint =
    checkpointLastBlock != null &&
    Number.isSafeInteger(existingCheckpointBlock) &&
    existingCheckpointBlock >= 0;
  const checkpointNextBlock = hasCheckpoint
    ? Math.max(startBlock, existingCheckpointBlock + 1)
    : startBlock;
  const shouldBackfillEmptyProtocol =
    hasCheckpoint &&
    existingPoolCount === 0 &&
    existingCheckpointBlock >= startBlock;
  const fromBlock = shouldBackfillEmptyProtocol
    ? startBlock
    : checkpointNextBlock;

  return {
    fromBlock,
    startBlock,
    resumed: hasCheckpoint && !shouldBackfillEmptyProtocol && fromBlock > startBlock,
    shouldBackfillEmptyProtocol,
  };
}

function normalizeDiscoveryDecodeResult(extracted: unknown): DecodeResult {
  const decoded = extracted && typeof extracted === "object"
    ? extracted as Record<string, unknown>
    : {};
  const poolAddress = typeof decoded.pool_address === "string"
    ? decoded.pool_address.trim().toLowerCase()
    : undefined;
  const tokens = Array.isArray(decoded.tokens)
    ? decoded.tokens
        .map((token) => (typeof token === "string" ? token.trim().toLowerCase() : null))
        .filter((token): token is string => Boolean(token))
    : [];
  const metadata =
    decoded.metadata && typeof decoded.metadata === "object" && !Array.isArray(decoded.metadata)
      ? decoded.metadata as Record<string, unknown>
      : {};

  return {
    pool_address: poolAddress,
    tokens,
    metadata,
  };
}

function assertDecodedLogsAligned(protocolName: string, logs: DiscoveryRawLog[], decodedLogs: unknown[]) {
  if (!Array.isArray(decodedLogs)) {
    throw new Error(`${protocolName} decoder returned a non-array decode result.`);
  }
  if (decodedLogs.length !== logs.length) {
    throw new Error(
      `${protocolName} decoder returned ${decodedLogs.length} decoded log(s) for ${logs.length} raw log(s).`,
    );
  }
}

export function decodeDiscoveryLogs(
  protocol: DiscoveryProtocol,
  logs: DiscoveryRawLog[],
  decodedLogs: unknown[],
): { extractedPools: DiscoveredPoolCandidate[]; errors: number } {
  assertDecodedLogsAligned(protocol.name, logs, decodedLogs);
  let errors = 0;
  const extractedPools: DiscoveredPoolCandidate[] = [];

  for (let i = 0; i < decodedLogs.length; i++) {
    const decoded = decodedLogs[i];
    const rawLog = logs[i];
    if (!decoded) continue;

    try {
      const extracted = normalizeDiscoveryDecodeResult(protocol.decode(decoded, rawLog) as DecodeResult);
      if (!extracted.pool_address || typeof extracted.pool_address !== "string") {
        console.warn(
          `  Warning: Could not extract pool address for ${protocol.name} at block ${rawLog.blockNumber}`
        );
        continue;
      }
      extractedPools.push({ extracted, rawLog });
    } catch (innerError: unknown) {
      errors++;
      if (errors <= 5) {
        console.error(
          `  Error decoding log #${i} for ${protocol.name}: ${errorMessage(innerError)}`
        );
      }
    }
  }

  return { extractedPools, errors };
}

function getDiscoveryQuerySpec(protocol: DiscoveryProtocol) {
  const signatures = discoverySignatures(protocol);
  if (signatures.length === 0) {
    throw new Error(`${protocol.name} has no discovery event signature or custom discover() implementation.`);
  }
  const cacheKey = `${protocol.address.toLowerCase()}:${signatures.join("|")}`;
  const cached = discoveryQuerySpecCache.get(cacheKey);
  if (cached) return cached;

  const topic0s = topic0sForSignatures(signatures);
  const spec = {
    topic0s,
    decoder: Decoder.fromSignatures(signatures),
  };
  discoveryQuerySpecCache.set(cacheKey, spec);
  return spec;
}

export function buildDiscoveryScanQuery(protocol: DiscoveryProtocol, fromBlock: number, chainHeight?: number | null) {
  const { topic0s } = getDiscoveryQuerySpec(protocol);
  const toBlock = discoveryQueryToBlock(chainHeight);
  return buildHyperSyncLogQuery({
    fromBlock,
    ...(toBlock != null ? { toBlock } : {}),
    logs: [
      {
        address: [protocol.address],
        topics: [topic0s],
      },
    ],
    logFields: DEFAULT_HYPERSYNC_LOG_FIELDS,
  });
}

export async function enrichDiscoveredPools(protocol: DiscoveryProtocol, extractedPools: DiscoveredPoolCandidate[]) {
  if (!protocol.enrichTokens) return { attempted: 0, failed: 0, earliestFailedBlock: null as number | null };

  const needsEnrichment = extractedPools.filter((p) => p.extracted.tokens.length === 0);
  if (needsEnrichment.length === 0) return { attempted: 0, failed: 0, earliestFailedBlock: null as number | null };

  console.log(
    `  Enriching ${needsEnrichment.length} pools via RPC (concurrency=${ENRICH_CONCURRENCY})...`
  );

  let failed = 0;
  let earliestFailedBlock: number | null = null;
  const enrichedTokens = await throttledMap(
    needsEnrichment,
    async (item) => {
      try {
        return await protocol.enrichTokens!(item.extracted);
      } catch (error: unknown) {
        failed++;
        const blockNumber = Number(item.rawLog.blockNumber);
        if (Number.isSafeInteger(blockNumber) && blockNumber >= 0) {
          earliestFailedBlock = earliestFailedBlock == null
            ? blockNumber
            : Math.min(earliestFailedBlock, blockNumber);
        }
        console.warn(
          `  [discover] Token enrichment failed for ${item.extracted.pool_address ?? "unknown pool"}: ${errorMessage(error)}`
        );
        return [];
      }
    },
    ENRICH_CONCURRENCY
  );

  for (let i = 0; i < needsEnrichment.length; i++) {
    needsEnrichment[i].extracted.tokens = enrichedTokens[i] || [];
  }

  return { attempted: needsEnrichment.length, failed, earliestFailedBlock };
}

// ─── Per-protocol discovery ────────────────────────────────────

async function discoverProtocol(
  key: string,
  protocol: DiscoveryProtocol,
  registry: RegistryService,
  context: { chainHeight?: number | null } = {},
) {
  if (typeof protocol.discover === "function") {
    return protocol.discover({ key, protocol, registry, ...context });
  }
  const checkpoint = registry.getCheckpoint(key);
  const existingPoolCount = registry.getPoolCountForProtocol(key);
  const {
    fromBlock,
    startBlock,
    resumed,
    shouldBackfillEmptyProtocol,
  } = resolveDiscoveryFromBlock(protocol, checkpoint?.last_block, existingPoolCount);

  console.log(
    `\n[${protocol.name}] Discovering from block ${fromBlock}` +
      (shouldBackfillEmptyProtocol
        ? ` (protocol empty at checkpoint tip — replaying from protocol start)`
        : resumed
          ? ` (resumed from checkpoint)`
          : startBlock === DEFAULT_DISCOVERY_START_BLOCK
            ? ` (chain start)`
            : ` (protocol start)`) +
      `...`
  );
  discoveryLogger.info(
    {
      protocol: key,
      fromBlock,
      startBlock,
      resumed,
      backfillEmptyProtocol: shouldBackfillEmptyProtocol,
      chainHeight: context.chainHeight ?? null,
    },
    "[discovery] Protocol scan starting",
  );

  const { decoder } = getDiscoveryQuerySpec(protocol);
  const query: HyperSyncLogQuery = buildDiscoveryScanQuery(protocol, fromBlock, context.chainHeight);

  const { logs, rollbackGuard, nextBlock } = await fetchAllLogs<DiscoveryRawLog>(query);
  let checkpointBlock = discoveryCheckpointFromNextBlock(nextBlock, fromBlock);

  if (logs.length === 0) {
    console.log(`  No new logs found for ${protocol.name}.`);
    registry.setCheckpoint(key, checkpointBlock);
    return { discovered: 0, checkpointBlock, rollbackGuard };
  }

  console.log(`  Found ${logs.length} discovery events for ${protocol.name}.`);

  const decodedLogs = await decoder.decodeLogs(logs);

  const { extractedPools, errors } = decodeDiscoveryLogs(protocol, logs, decodedLogs);
  const enrichment = await enrichDiscoveredPools(protocol, extractedPools);
  if (enrichment.failed > 0 && enrichment.earliestFailedBlock != null) {
    checkpointBlock = Math.max(0, enrichment.earliestFailedBlock - 1);
    discoveryLogger.warn(
      {
        protocol: key,
        enrichmentFailures: enrichment.failed,
        enrichmentAttempts: enrichment.attempted,
        earliestFailedBlock: enrichment.earliestFailedBlock,
        checkpointBlock,
      },
      "[discovery] Token enrichment failed; checkpoint held before earliest failed event for retry",
    );
  }
  const poolBatch = buildDiscoveredPoolBatch(key, extractedPools);

  let hydrationPromise: Promise<number> | null = null;
  if (poolBatch.length > 0) {
    registry.batchUpsertPools(poolBatch);
    hydrationPromise = hydrateNewTokens(poolBatch, registry).catch((err) => {
      console.warn(`  [discover] Token hydration failed: ${err.message}`);
      return 0;
    });
  }

  registry.setCheckpoint(key, checkpointBlock);

  if (errors > 5) console.warn(`  ... and ${errors - 5} more decode errors suppressed.`);
  console.log(`  Inserted/updated ${poolBatch.length} pools for ${protocol.name}.`);
  discoveryLogger.info(
    {
      protocol: key,
      logs: logs.length,
      decodedPools: extractedPools.length,
      insertedPools: poolBatch.length,
      decodeErrors: errors,
      checkpointBlock,
    },
    "[discovery] Protocol scan complete",
  );

  return { discovered: poolBatch.length, checkpointBlock, rollbackGuard, hydrationPromise };
}

// ─── Curve PoolRemoved lifecycle ───────────────────────────────

async function discoverCurveRemovals(registry: RegistryService, context: { chainHeight?: number | null } = {}) {
  const checkpointKey = "CURVE_POOL_REMOVED";
  const checkpoint = registry.getCheckpoint(checkpointKey);
  const { fromBlock, startBlock, resumed } = resolveDiscoveryFromBlock(
    CURVE_POOL_REMOVED,
    checkpoint?.last_block,
    1,
  );

  console.log(
    `\n[Curve PoolRemoved] Scanning from block ${fromBlock}` +
      (resumed
        ? ` (resumed from checkpoint)`
        : startBlock === DEFAULT_DISCOVERY_START_BLOCK
          ? ` (chain start)`
          : ` (protocol start)`) +
      `...`,
  );

  const { topic0s, decoder } = getDiscoveryQuerySpec(CURVE_POOL_REMOVED as DiscoveryProtocol);

  const toBlock = discoveryQueryToBlock(context.chainHeight);
  const query = buildHyperSyncLogQuery({
    fromBlock,
    ...(toBlock != null ? { toBlock } : {}),
    logs: [
      {
        address: [CURVE_POOL_REMOVED.address],
        topics: [topic0s],
      },
    ],
    logFields: [
      LogField.Address,
      LogField.Topic0,
      LogField.Topic1,
      LogField.BlockNumber,
      LogField.TransactionHash,
    ],
  });

  const { logs, rollbackGuard, nextBlock } = await fetchAllLogs<DiscoveryRawLog>(query);
  const checkpointBlock = discoveryCheckpointFromNextBlock(nextBlock, fromBlock);

  if (logs.length === 0) {
    console.log(`  No Curve PoolRemoved events found.`);
    registry.setCheckpoint(checkpointKey, checkpointBlock);
    return { removed: 0, checkpointBlock, rollbackGuard };
  }

  const decodedLogs = await decoder.decodeLogs(logs);
  const removedPoolBlocks = new Map<string, number>();

  for (let i = 0; i < decodedLogs.length; i++) {
    const decoded = decodedLogs[i];
    if (!decoded) continue;

    const poolAddress = decodedIndexedString(decoded, 0)?.toLowerCase();
    const blockNumber = Number(logs[i]?.blockNumber ?? 0);
    if (poolAddress) {
      const prior = removedPoolBlocks.get(poolAddress);
      if (prior == null || (Number.isFinite(blockNumber) && blockNumber < prior)) {
        removedPoolBlocks.set(poolAddress, Number.isFinite(blockNumber) ? blockNumber : 0);
      }
    }
  }

  const removed = registry.batchRemovePools(
    [...removedPoolBlocks.entries()].map(([address, block]) => ({
      address,
      removed_block: block,
    })),
  );
  registry.setCheckpoint(checkpointKey, checkpointBlock);
  console.log(`  Marked ${removed} pools as removed from ${removedPoolBlocks.size} removal event(s).`);
  discoveryLogger.info(
    {
      protocol: checkpointKey,
      removalEvents: removedPoolBlocks.size,
      poolsRemoved: removed,
      checkpointBlock,
    },
    "[discovery] Curve removal scan complete",
  );
  return { removed, checkpointBlock, rollbackGuard };
}

export function protocolSupportsDiscovery(protocol: DiscoveryProtocol, protocolKey?: string) {
  if (!ENABLE_V3_PROTOCOLS && ALL_V3_PROTOCOLS.has(normalizeProtocolKey(protocolKey))) return false;
  if (protocol.capabilities?.discovery === false) return false;
  if (protocol.capabilities?.execution === false) return false;
  if (typeof protocol.discover === "function") return true;
  return typeof protocol.decode === "function" && discoverySignatures(protocol).length > 0;
}

type DiscoverPoolsDeps = {
  registry?: RegistryService;
  protocols?: Record<string, DiscoveryProtocol>;
  getChainHeightFn?: () => Promise<number>;
  discoverProtocolFn?: typeof discoverProtocol;
  discoverCurveRemovalsFn?: typeof discoverCurveRemovals;
  detectReorgFn?: typeof detectReorg;
  protocolConcurrency?: number;
};

function discoveryProtocolCoverage(
  registry: RegistryService,
  discoveryEntries: Array<[string, DiscoveryProtocol]>,
  protocolResults: ProtocolRunResult[],
): ProtocolCoverageEntry[] {
  const resultByProtocol = new Map(protocolResults.map((entry) => [entry.key, entry]));
  return discoveryEntries.map(([key, protocol]) => {
    const result = resultByProtocol.get(key);
    const checkpointBlock = numericCheckpointBlock(registry.getCheckpoint(key)?.last_block);
    return {
      protocol: key,
      name: protocol.name,
      activePools: registry.getPoolCountForProtocol(key, "active"),
      totalPools: registry.getPoolCountForProtocol(key),
      checkpointBlock,
      discovered: Number(result?.result?.discovered ?? 0),
      error: result?.error ? errorMessage(result.error) : null,
    };
  });
}

// ─── Public entry point ────────────────────────────────────────

export async function discoverPoolsWithDeps(deps: DiscoverPoolsDeps = {}) {
  const registry = deps.registry ?? new RegistryService(DB_PATH);
  const shouldCloseRegistry = !deps.registry;
  const protocols = deps.protocols ?? (PROTOCOLS as Record<string, DiscoveryProtocol>);
  const getChainHeightFn = deps.getChainHeightFn ?? (async () => Number(await client.getHeight()));
  const discoverProtocolFn = deps.discoverProtocolFn ?? discoverProtocol;
  const discoverCurveRemovalsFn = deps.discoverCurveRemovalsFn ?? discoverCurveRemovals;
  const detectReorgFn = deps.detectReorgFn ?? detectReorg;
  const protocolConcurrency = Math.max(1, Number(deps.protocolConcurrency ?? DISCOVERY_PROTOCOL_CONCURRENCY) || 1);
  const pendingHydrations: Promise<number>[] = [];
  let chainHeight: number | null = null;

  console.log("=== Polygon Pool Discovery (HyperSync) ===");
  console.log(`HyperSync URL: ${HYPERSYNC_URL}`);
  console.log(`API Token: ${ENVIO_API_TOKEN ? "configured" : "NOT SET"}`);

  try {
    chainHeight = await getChainHeightFn();
    console.log(`Chain height: ${chainHeight}`);
  } catch (e: unknown) {
    console.warn(`Could not fetch chain height: ${errorMessage(e)}`);
  }

  let totalDiscovered = 0;
  const discoveryEntries = (Object.entries(protocols) as Array<[string, DiscoveryProtocol]>).filter(([key, protocol]) => {
    if (!protocolSupportsDiscovery(protocol, key)) {
      console.log(`Skipping ${protocol.name}: discovery disabled for non-executable protocol.`);
      return false;
    }
    return true;
  });

  discoveryLogger.info(
    {
      protocols: discoveryEntries.length,
      protocolConcurrency,
      chainHeight,
    },
    "[discovery] Starting protocol batch",
  );

  try {
    const protocolResults = await throttledMap(
      discoveryEntries,
      async ([key, protocol]: [string, DiscoveryProtocol]) => {
        try {
          const result = await discoverProtocolFn(key, protocol, registry, { chainHeight });
          return { key, protocol, result, error: null };
        } catch (error: unknown) {
          return { key, protocol, result: null, error };
        }
      },
      protocolConcurrency,
    );

    for (const entry of protocolResults) {
      if (entry.error) {
        console.error(`Error discovering ${entry.protocol.name}: ${errorMessage(entry.error)}`);
        const stack = errorStack(entry.error);
        if (stack) console.error(stack);
        continue;
      }

      const result = entry.result;
      if (!result) continue;
      totalDiscovered += Number(result.discovered ?? 0);
      if (result.hydrationPromise) pendingHydrations.push(result.hydrationPromise);

      if (result.rollbackGuard) {
        const reorgBlock = detectReorgFn(registry, result.rollbackGuard);
        if (reorgBlock !== false) {
          console.warn(`\n⚠ REORG DETECTED at block ${reorgBlock}! Rolling back...`);
          const rb = rollbackSummary(registry.rollbackToBlock(reorgBlock));
          console.warn(`  Rolled back: ${rb.poolsRemoved} pools, ${rb.statesRemoved} states`);
        }
        registry.setRollbackGuard(result.rollbackGuard);
      }
    }

    try {
      const result = await discoverCurveRemovalsFn(registry, { chainHeight });
      if (result.rollbackGuard) {
        const reorgBlock = detectReorgFn(registry, result.rollbackGuard);
        if (reorgBlock !== false) {
          console.warn(`\n⚠ REORG DETECTED at block ${reorgBlock}! Rolling back...`);
          const rb = rollbackSummary(registry.rollbackToBlock(reorgBlock));
          console.warn(`  Rolled back: ${rb.poolsRemoved} pools, ${rb.statesRemoved} states`);
        }
        registry.setRollbackGuard(result.rollbackGuard);
      }
    } catch (error: unknown) {
      console.error(`Error discovering Curve removals: ${errorMessage(error)}`);
    }

    if (pendingHydrations.length > 0) {
      console.log(`Waiting for ${pendingHydrations.length} token hydration task(s) to finish...`);
      await Promise.allSettled(pendingHydrations);
    }

    const protocolCoverage = discoveryProtocolCoverage(registry, discoveryEntries, protocolResults);
    const protocolFamilyCoverage = summarizeProtocolCoverageByFamily(protocolCoverage);
    const populatedProtocols = protocolCoverage.filter((entry) => entry.activePools > 0);
    discoveryLogger.info(
      {
        protocols: protocolCoverage,
        protocolFamilies: protocolFamilyCoverage,
        populatedProtocols: populatedProtocols.length,
        emptyProtocols: protocolCoverage.length - populatedProtocols.length,
      },
      "[discovery] Registry protocol coverage",
    );
    if (protocolCoverage.length > 1 && populatedProtocols.length === 1) {
      discoveryLogger.warn(
        {
          populatedProtocol: populatedProtocols[0]?.protocol ?? null,
          protocols: protocolCoverage,
        },
        "[discovery] Only one discoverable protocol has active pools in the registry",
      );
    }

    const totalPools = registry.getPoolCount();
    const activePools = registry.getActivePoolCount();
    console.log(`\n=== Discovery Complete ===`);
    console.log(`New pools discovered this run: ${totalDiscovered}`);
    console.log(`Total pools in registry: ${totalPools} (${activePools} active)`);
    const activeFamilies = protocolFamilyCoverage.filter((entry) => entry.activePools > 0);
    if (activeFamilies.length > 0) {
      const familySummary = activeFamilies
        .map((entry) => `${entry.name}: ${entry.activePools}`)
        .join(", ");
      console.log(`Active pools by protocol family: ${familySummary}`);
    }

    return { totalDiscovered, totalPools, activePools, protocolCoverage, protocolFamilyCoverage };
  } finally {
    if (shouldCloseRegistry) {
      registry.close();
    }
  }
}

export async function discoverPools() {
  return discoverPoolsWithDeps();
}
