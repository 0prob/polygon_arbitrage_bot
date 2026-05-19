export { createHypersyncClient, client, Decoder, LogField, BlockField, JoinMode, setHypersyncDefaults } from "./client.ts";
export { buildLogQuery, normalizeLogFilter, computeTopic0, computeTopic0s } from "./query.ts";
export { fetchAllLogs } from "./stream.ts";
export type {
  HyperSyncLogFilter,
  HyperSyncQuery,
  HyperSyncFieldSelection,
  HyperSyncClientConfig,
  HyperSyncLog,
  HyperSyncBlockHeader,
  StreamConfig,
  StreamProgress,
  HyperSyncStream,
  HyperSyncGetResponse,
  HypersyncClientRuntime,
  HypersyncDecoderRuntime,
  HypersyncDecodedLog,
} from "./types.ts";
