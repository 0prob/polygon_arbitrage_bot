
/**
 * src/hypersync/index.js — Barrel export for HyperSync layer
 */

export {
  client,
  Decoder,
  LogField,
  BlockField,
  JoinMode,
  createHypersyncClient,
  createUnavailableHypersyncClient,
  normalizeHypersyncClientConfig,
  type HypersyncClientRuntime,
} from "./client.ts";
export { fetchAllLogs, fetchAllLogsWithClient } from "./paginate.ts";
export {
  applyHistoricalHyperSyncQueryPolicy,
  buildHyperSyncLogQuery,
  DEFAULT_HYPERSYNC_BLOCK_FIELDS,
  DEFAULT_HYPERSYNC_LOG_FIELDS,
  type HyperSyncGetResponse,
  type HyperSyncLogFilter,
  type HyperSyncLogQuery,
} from "./query_policy.ts";
export {
  compareHyperSyncLogs,
  hyperSyncLogIdentityKey,
  normalizeHyperSyncLogInteger,
  normalizeHyperSyncLogMeta,
  topicArrayFromHyperSyncLog,
  type HyperSyncRawLog,
  type NormalizedHyperSyncLogMeta,
} from "./logs.ts";
export { normalizeTopic, topic0ForSignature, topic0sForSignatures } from "./topics.ts";
